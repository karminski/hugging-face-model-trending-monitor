#include "config.h"
#include "battery.h"
#include "buttons.h"
#include "calendar.h"
#include "dashboard.h"
#include "demo_tsv.h"
#include "net.h"
#include "self_test.h"
#include "ST7305_U8g2.h"
#include "trending.h"

#include <Preferences.h>
#include <math.h>
#include <string.h>

constexpr int kLcdSckPin = 11;
constexpr int kLcdMosiPin = 12;
constexpr int kLcdDcPin = 5;
constexpr int kLcdCsPin = 40;
constexpr int kLcdResetPin = 41;
constexpr uint32_t kBatteryRefreshMs = 30000;
constexpr uint32_t kChargeRefreshMs = 1000;
constexpr uint32_t kPageIntervalMs = 10000;
constexpr uint32_t kManualPauseMs = 10UL * 60UL * 1000UL;
constexpr uint32_t kCalendarDwellMs = 10000;
constexpr uint32_t kCalendarBadgeMs = 1500;
constexpr float kScrollSmoothing = 5.0f;
constexpr float kScrollSnap = 0.02f;

ST7305_U8g2 display(
    kLcdSckPin,
    kLcdMosiPin,
    kLcdDcPin,
    kLcdCsPin,
    kLcdResetPin);

TrendingBoard demoBoard = {};
bool demoReady = false;

// Selected calendar dither by name, so it survives reboots and bundle changes.
// Empty means the bundle's default mode.
char calendarModeName[kCalendarModeNameSize] = "";

void loadCalendarMode()
{
    Preferences prefs;
    if (prefs.begin("calendar", true)) {
        prefs.getString("mode", calendarModeName, sizeof(calendarModeName));
        prefs.end();
    }
}

void saveCalendarMode()
{
    Preferences prefs;
    if (prefs.begin("calendar", false)) {
        prefs.putString("mode", calendarModeName);
        prefs.end();
    }
}

int resolveCalendarMode(const CalendarView &calendar)
{
    const int index = calendarFindMode(calendar, calendarModeName);
    return index >= 0 ? index : calendar.defaultMode;
}

enum ViewMode {
    VIEW_HF = 0,
    VIEW_CALENDAR,
    VIEW_DEBUG,
};

void printSerialLine(const char *line)
{
    Serial.println(line);
}

bool demoMode()
{
    return WIFI_SSID[0] == '\0' || strcmp(WIFI_SSID, "your-ssid") == 0;
}

void formatFooter(uint32_t nextRefreshAtMs, uint32_t now, char *output, size_t outputSize)
{
    if (demoMode()) {
        snprintf(output, outputSize, "DEMO");
        return;
    }
    if (nextRefreshAtMs == 0) {
        snprintf(output, outputSize, "WAIT");
        return;
    }

    const uint32_t remaining = nextRefreshAtMs - now;
    if (static_cast<int32_t>(remaining) < 0) {
        snprintf(output, outputSize, "NOW");
        return;
    }
    if (remaining >= 60000) {
        snprintf(output, outputSize, "NEXT %lum", static_cast<unsigned long>(remaining / 60000));
        return;
    }
    snprintf(output, outputSize, "NEXT %lus", static_cast<unsigned long>(remaining / 1000));
}

int positiveMod(int value, int modulus)
{
    if (modulus <= 0) {
        return 0;
    }
    const int result = value % modulus;
    return result < 0 ? result + modulus : result;
}

bool approachScroll(float &position, float target)
{
    const float delta = target - position;
    if (fabsf(delta) <= kScrollSnap) {
        position = target;
        return false;
    }
    position += delta / kScrollSmoothing;
    return true;
}

void wrapScroll(float &position, float &target, int count)
{
    if (count <= 0) {
        position = 0.0f;
        target = 0.0f;
        return;
    }
    while (position <= -1.0f && target <= -1.0f) {
        position += count;
        target += count;
    }
    while (position >= count && target >= count) {
        position -= count;
        target -= count;
    }
}

void setup()
{
    Serial.begin(115200);
    delay(300);

    Serial.println("HF model trending panel starting");
    Serial.printf("Refresh interval %lu s, retry %lu s\n", kTrendingRefreshMs / 1000, kTrendingRetryMs / 1000);
    runTrendingSelfTest(printSerialLine);
    loadCalendarMode();
    Serial.printf("Calendar mode %s\n", calendarModeName[0] == '\0' ? "(default)" : calendarModeName);
    batteryBegin();
    buttonsBegin();

    // U8G2_R1 rotates the native 300x400 panel into 400x300 landscape mode.
    // The panel power rail can settle later than the ESP32 after a PWR-button boot.
    delay(3000);
    display.begin(0, U8G2_R1);

    if (demoMode()) {
        char buffer[4096];
        strncpy(buffer, kDemoTsv, sizeof(buffer) - 1);
        buffer[sizeof(buffer) - 1] = '\0';
        demoReady = parseTrendingTsv(buffer, &demoBoard);
        Serial.println("DEMO MODE: client/config.h still has the example SSID.");
        Serial.println("Edit WIFI_SSID, WIFI_PASSWORD, and TRENDING_API_URL, then flash again.");
        Serial.printf("Demo parse %s, models=%d\n", demoReady ? "ok" : "failed", demoBoard.count);
        return;
    }

    netTaskStart();
}

void loop()
{
    static float scrollPosition = 0.0f;
    static float scrollTarget = 0.0f;
    static int scrollCount = -1;
    static int loggedItem = -1;
    static uint32_t lastPageMs = 0;
    static int drawnOrigin = -1;
    static int drawnOffset = -1;
    static uint32_t drawnGeneration = 0;
    static int drawnMinute = -999;
    static int drawnBatteryPercent = -1;
    static bool drawnBatteryCharging = false;
    static bool pageClockStarted = false;
    static bool debugMode = false;
    static bool drawnDebugMode = false;
    static uint32_t manualPauseUntilMs = 0;
    static bool wasManuallyPaused = false;
    static uint32_t nextDisplayRecoveryMs = 0;
    static int displayRecoveryAttempts = 0;
    static uint32_t nextBatteryReadMs = 0;
    static int batteryPercent = 0;
    static bool batteryCharging = false;
    static uint32_t nextChargeReadMs = 0;
    static int renderFps = 0;
    static ViewMode view = VIEW_HF;
    static ViewMode drawnView = VIEW_HF;
    static uint32_t calendarShownAtMs = 0;
    static CalendarTicker calendarTicker = {};
    static int drawnCalendarFrame = -1;
    static int drawnTickerOffset = -1;
    static uint32_t drawnCalendarGeneration = 0;
    static bool drawnCalendarPlaceholder = false;
    static int drawnCalendarMode = -1;
    static bool drawnCalendarBadge = false;
    static uint32_t calendarBadgeUntilMs = 0;
    static CalendarPlayer calendarPlayer = {};

    const uint32_t now = millis();
    if (nextBatteryReadMs == 0 ||
        static_cast<int32_t>(now - nextBatteryReadMs) >= 0) {
        batteryPercent = batteryReadPercent();
        nextBatteryReadMs = now + kBatteryRefreshMs;
    }
    if (nextChargeReadMs == 0 ||
        static_cast<int32_t>(now - nextChargeReadMs) >= 0) {
        batteryCharging = batteryIsCharging();
        nextChargeReadMs = now + kChargeRefreshMs;
    }
    if (nextDisplayRecoveryMs == 0) {
        nextDisplayRecoveryMs = now + 5000;
    }
    bool displayRecoveryRedraw = false;
    if (displayRecoveryAttempts < 2 &&
        static_cast<int32_t>(now - nextDisplayRecoveryMs) >= 0) {
        display.fullInit();
        displayRecoveryAttempts += 1;
        nextDisplayRecoveryMs = now + 5000;
        displayRecoveryRedraw = true;
        Serial.printf(
            "ST7305 startup recovery %d/2\n",
            displayRecoveryAttempts);
    }
    // The snapshot holds ten model records, so keep it off the 8 KB loop stack.
    static NetSnapshot snapshot = {};
    bool ready = false;
    if (demoMode()) {
        snapshot.phase = demoReady ? NET_ONLINE : NET_ERROR;
        snapshot.generation = 1;
        snapshot.hasBoard = demoReady;
        snapshot.board = demoBoard;
        snprintf(snapshot.detail, sizeof(snapshot.detail), "%s", demoReady ? "DEMO" : "PARSE");
        ready = true;
    } else {
        ready = netCopySnapshot(&snapshot);
    }

    const int itemCount = snapshot.hasBoard ? snapshot.board.count : 0;
    if (itemCount != scrollCount) {
        scrollPosition = 0.0f;
        scrollTarget = 0.0f;
        scrollCount = itemCount;
        lastPageMs = now;
    }
    wrapScroll(scrollPosition, scrollTarget, itemCount);
    const auto showCalendar = [&]() {
        view = VIEW_CALENDAR;
        calendarShownAtMs = now;
        calendarTickerReset(&calendarTicker, now);
    };
    const auto showBoard = [&]() {
        view = VIEW_HF;
        scrollPosition = 0.0f;
        scrollTarget = 0.0f;
        lastPageMs = now;
    };

    const ButtonAction action = buttonsPoll(now);
    if (action == BUTTON_TOGGLE_MODE && !debugMode) {
        if (view == VIEW_CALENDAR) {
            showBoard();
        } else {
            showCalendar();
        }
        manualPauseUntilMs = now + kManualPauseMs;
        Serial.printf(
            "Manual switch to %s; auto rotation paused for 10 minutes\n",
            view == VIEW_CALENDAR ? "calendar" : "HF board");
    } else if (action == BUTTON_TOGGLE_DEBUG) {
        debugMode = !debugMode;
        Serial.printf("Debug view %s\n", debugMode ? "enabled" : "disabled");
    } else if (debugMode && action == BUTTON_PREVIOUS_PAGE) {
        debugMode = false;
        Serial.println("Debug view exited");
    } else if (debugMode && action == BUTTON_NEXT_PAGE) {
        netRequestRefresh();
    } else if (view == VIEW_CALENDAR &&
        (action == BUTTON_PREVIOUS_PAGE || action == BUTTON_NEXT_PAGE)) {
        const CalendarView *calendar = netLockCalendar();
        if (calendar != nullptr) {
            const int index = positiveMod(
                resolveCalendarMode(*calendar) + (action == BUTTON_NEXT_PAGE ? 1 : -1),
                calendar->modeCount);
            snprintf(calendarModeName, sizeof(calendarModeName), "%s", calendar->modes[index].name);
            Serial.printf(
                "Calendar mode %s (%d/%d); auto rotation paused for 10 minutes\n",
                calendarModeName,
                index + 1,
                calendar->modeCount);
            netUnlockCalendar();
            saveCalendarMode();
            calendarBadgeUntilMs = now + kCalendarBadgeMs;
            manualPauseUntilMs = now + kManualPauseMs;
        }
    } else if (view == VIEW_HF &&
        (action == BUTTON_PREVIOUS_PAGE || action == BUTTON_NEXT_PAGE)) {
        if (itemCount > 1) {
            scrollTarget += action == BUTTON_NEXT_PAGE ? 1.0f : -1.0f;
        }
        manualPauseUntilMs = now + kManualPauseMs;
        lastPageMs = now;
        Serial.printf(
            "Manual item scroll; auto paused for 10 minutes\n");
    }

    const bool manuallyPaused =
        manualPauseUntilMs != 0 &&
        static_cast<int32_t>(manualPauseUntilMs - now) > 0;
    if (wasManuallyPaused && !manuallyPaused) {
        lastPageMs = now;
        calendarShownAtMs = now;
        manualPauseUntilMs = 0;
        Serial.println("Automatic item scroll resumed");
    }
    wasManuallyPaused = manuallyPaused;

    const bool autoRotate = !debugMode && !manuallyPaused && ready;
    if (!pageClockStarted) {
        lastPageMs = now;
        pageClockStarted = true;
    } else if (autoRotate && view == VIEW_HF && itemCount > 0 &&
        now - lastPageMs >= kPageIntervalMs) {
        // One full pass over the board ends on the calendar page.
        const int current = positiveMod(static_cast<int>(lroundf(scrollTarget)), itemCount);
        if (current == itemCount - 1 && snapshot.hasCalendar) {
            showCalendar();
            Serial.println("Board loop done; showing calendar");
        } else if (itemCount > 1) {
            scrollTarget += 1.0f;
        }
        lastPageMs = now;
    } else if (autoRotate && view == VIEW_CALENDAR &&
        now - calendarShownAtMs >= kCalendarDwellMs) {
        showBoard();
        Serial.println("Calendar dwell done; back to HF board");
    }

    const bool scrolling = !debugMode && approachScroll(scrollPosition, scrollTarget);
    wrapScroll(scrollPosition, scrollTarget, itemCount);
    int originIndex = 0;
    int pixelOffset = 0;
    if (itemCount > 0) {
        originIndex = static_cast<int>(floorf(scrollPosition));
        const float fraction = scrollPosition - originIndex;
        pixelOffset = static_cast<int>(lroundf(fraction * kDashboardCardStride));
        if (pixelOffset >= kDashboardCardStride) {
            pixelOffset = 0;
            originIndex += 1;
        }
        originIndex = positiveMod(originIndex, itemCount);
    }

    char footer[16];
    formatFooter(snapshot.nextRefreshAtMs, now, footer, sizeof(footer));
    uint32_t pauseRemainingMs = 0;
    if (manuallyPaused) {
        pauseRemainingMs = manualPauseUntilMs - now;
        snprintf(
            footer,
            sizeof(footer),
            "HOLD %lum",
            static_cast<unsigned long>((pauseRemainingMs + 59999) / 60000));
    }
    int minute = -1;
    if (!demoMode() && snapshot.nextRefreshAtMs != 0) {
        const uint32_t remaining = snapshot.nextRefreshAtMs - now;
        minute = static_cast<int32_t>(remaining) < 0 ? 0 : static_cast<int>(remaining / 60000);
    }

    if (!debugMode && view == VIEW_CALENDAR) {
        const CalendarView *calendar = netLockCalendar();
        if (calendar == nullptr) {
            if (drawnView != VIEW_CALENDAR || !drawnCalendarPlaceholder || displayRecoveryRedraw) {
                char detail[24] = "";
                if (snapshot.calendarHttpCode != 0) {
                    snprintf(detail, sizeof(detail), "LAST RESULT %d", snapshot.calendarHttpCode);
                }
                drawCalendar(display, nullptr, nullptr, 0, nullptr, detail, true);
                drawnCalendarPlaceholder = true;
                drawnView = VIEW_CALENDAR;
            }
            delay(50);
            return;
        }
        const bool fresh = drawnView != VIEW_CALENDAR || drawnCalendarPlaceholder ||
            snapshot.calendarGeneration != drawnCalendarGeneration;
        if (fresh && snapshot.calendarGeneration != drawnCalendarGeneration) {
            calendarTickerReset(&calendarTicker, now);
        }
        calendarTickerAdvance(&calendarTicker, *calendar, now);
        const int modeIndex = resolveCalendarMode(*calendar);
        const CalendarMode &mode = calendar->modes[modeIndex];
        const int frameIndex =
            static_cast<int>((now - calendarShownAtMs) * calendar->fps / 1000UL) % mode.frameCount;
        const bool badge = static_cast<int32_t>(calendarBadgeUntilMs - now) > 0;
        char label[32] = "";
        if (badge) {
            snprintf(label, sizeof(label), "%s %d/%d", mode.name, modeIndex + 1, calendar->modeCount);
        }
        const bool full = fresh || displayRecoveryRedraw;
        if (full || modeIndex != drawnCalendarMode || badge != drawnCalendarBadge ||
            frameIndex != drawnCalendarFrame || calendarTicker.offset != drawnTickerOffset) {
            const uint32_t drawStartMs = millis();
            const uint8_t *scene = calendarPlayerFrame(&calendarPlayer, *calendar, modeIndex, frameIndex);
            drawCalendar(display, calendar, scene, calendarTicker.offset, label, nullptr, full);
            if (full) {
                Serial.printf("Calendar full redraw %lu ms\n", static_cast<unsigned long>(millis() - drawStartMs));
            }
            drawnCalendarMode = modeIndex;
            drawnCalendarBadge = badge;
            drawnCalendarFrame = frameIndex;
            drawnTickerOffset = calendarTicker.offset;
        }
        netUnlockCalendar();
        drawnCalendarGeneration = snapshot.calendarGeneration;
        drawnCalendarPlaceholder = false;
        drawnView = VIEW_CALENDAR;
        delay(10);
        return;
    }

    const ViewMode targetView = debugMode ? VIEW_DEBUG : VIEW_HF;
    const bool changed = ready &&
        (displayRecoveryRedraw || targetView != drawnView ||
         scrolling || originIndex != drawnOrigin ||
         pixelOffset != drawnOffset ||
         snapshot.generation != drawnGeneration ||
         minute != drawnMinute || batteryPercent != drawnBatteryPercent ||
         batteryCharging != drawnBatteryCharging ||
         debugMode != drawnDebugMode ||
         debugMode);
    if (!changed) {
        delay(50);
        return;
    }

    if (debugMode) {
        const uint32_t frameStartUs = micros();
        drawDebugDashboard(
            display,
            snapshot,
            pauseRemainingMs,
            batteryPercent,
            batteryCharging,
            renderFps);
        uint32_t frameUs = micros() - frameStartUs;
        if (frameUs == 0) {
            frameUs = 1;
        }
        const int instantFps = static_cast<int>(1000000UL / frameUs);
        renderFps = renderFps <= 0 ? instantFps : (renderFps * 3 + instantFps) / 4;
    } else {
        renderFps = 0;
        drawDashboard(
            display,
            &snapshot.board,
            snapshot.hasBoard,
            snapshot.detail,
            originIndex,
            pixelOffset,
            footer,
            batteryPercent,
            batteryCharging);
    }
    drawnOrigin = originIndex;
    drawnOffset = pixelOffset;
    drawnGeneration = snapshot.generation;
    drawnMinute = minute;
    drawnBatteryPercent = batteryPercent;
    drawnBatteryCharging = batteryCharging;
    drawnDebugMode = debugMode;
    drawnView = targetView;
    const int shownItem = itemCount == 0
        ? -1
        : positiveMod(static_cast<int>(lroundf(scrollPosition)), itemCount);
    if (shownItem != loggedItem) {
        loggedItem = shownItem;
        Serial.printf(
            "item %d/%d status %s models %d footer %s\n",
            shownItem < 0 ? 0 : shownItem + 1,
            itemCount,
            snapshot.detail,
            itemCount,
            footer);
    }
}
