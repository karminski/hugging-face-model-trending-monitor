#include "config.h"
#include "battery.h"
#include "buttons.h"
#include "dashboard.h"
#include "demo_tsv.h"
#include "net.h"
#include "self_test.h"
#include "ST7305_U8g2.h"
#include "trending.h"

#include <math.h>
#include <string.h>

constexpr int kLcdSckPin = 11;
constexpr int kLcdMosiPin = 12;
constexpr int kLcdDcPin = 5;
constexpr int kLcdCsPin = 40;
constexpr int kLcdResetPin = 41;
constexpr uint32_t kBatteryRefreshMs = 30000;
constexpr uint32_t kPageIntervalMs = 10000;
constexpr uint32_t kManualPauseMs = 10UL * 60UL * 1000UL;
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
    static uint32_t drawnDebugGeneration = 0;
    static int drawnMinute = -999;
    static int drawnBatteryPercent = -1;
    static bool pageClockStarted = false;
    static bool debugMode = false;
    static bool drawnDebugMode = false;
    static uint32_t manualPauseUntilMs = 0;
    static bool wasManuallyPaused = false;
    static uint32_t nextDisplayRecoveryMs = 0;
    static int displayRecoveryAttempts = 0;
    static uint32_t nextBatteryReadMs = 0;
    static int batteryPercent = 0;

    const uint32_t now = millis();
    if (nextBatteryReadMs == 0 ||
        static_cast<int32_t>(now - nextBatteryReadMs) >= 0) {
        batteryPercent = batteryReadPercent();
        nextBatteryReadMs = now + kBatteryRefreshMs;
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
    }
    wrapScroll(scrollPosition, scrollTarget, itemCount);
    const ButtonAction action = buttonsPoll(now);
    if (action == BUTTON_TOGGLE_DEBUG) {
        debugMode = !debugMode;
        Serial.printf("Debug view %s\n", debugMode ? "enabled" : "disabled");
    } else if (debugMode && action == BUTTON_PREVIOUS_PAGE) {
        debugMode = false;
        Serial.println("Debug view exited");
    } else if (debugMode && action == BUTTON_NEXT_PAGE) {
        netRequestRefresh();
    } else if (action == BUTTON_PREVIOUS_PAGE || action == BUTTON_NEXT_PAGE) {
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
        manualPauseUntilMs = 0;
        Serial.println("Automatic item scroll resumed");
    }
    wasManuallyPaused = manuallyPaused;

    if (!pageClockStarted) {
        lastPageMs = now;
        pageClockStarted = true;
    } else if (!debugMode && !manuallyPaused && ready && itemCount > 1 &&
        now - lastPageMs >= kPageIntervalMs) {
        scrollTarget += 1.0f;
        lastPageMs = now;
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

    const bool changed = ready &&
        (displayRecoveryRedraw || scrolling || originIndex != drawnOrigin ||
         pixelOffset != drawnOffset ||
         snapshot.generation != drawnGeneration ||
         minute != drawnMinute || batteryPercent != drawnBatteryPercent ||
         debugMode != drawnDebugMode ||
         (debugMode && snapshot.debugGeneration != drawnDebugGeneration));
    if (!changed) {
        delay(50);
        return;
    }

    if (debugMode) {
        drawDebugDashboard(
            display,
            snapshot,
            pauseRemainingMs,
            batteryPercent);
    } else {
        drawDashboard(
            display,
            &snapshot.board,
            snapshot.hasBoard,
            snapshot.detail,
            originIndex,
            pixelOffset,
            footer,
            batteryPercent);
    }
    drawnOrigin = originIndex;
    drawnOffset = pixelOffset;
    drawnGeneration = snapshot.generation;
    drawnDebugGeneration = snapshot.debugGeneration;
    drawnMinute = minute;
    drawnBatteryPercent = batteryPercent;
    drawnDebugMode = debugMode;
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
