#include "calendar.h"

#include "ST7305_U8g2.h"

#include <esp_heap_caps.h>
#include <stdlib.h>
#include <string.h>

namespace {

constexpr int kHeaderSize = 40;
constexpr int kVersion = 3;
constexpr int kModeRecordSize = 16;
constexpr int kModeNameBytes = 12;
constexpr int kScreenWidth = 400;
constexpr int kScreenHeight = 300;
constexpr uint32_t kTickerStepMs = 60;
constexpr int kTickerPauseSteps = 40;

uint16_t readU16(const uint8_t *p)
{
    return static_cast<uint16_t>(p[0] | (p[1] << 8));
}

uint32_t readU32(const uint8_t *p)
{
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
        (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

size_t xbmBytes(int width, int height)
{
    return static_cast<size_t>((width + 7) / 8) * static_cast<size_t>(height);
}

bool rectInScreen(const CalendarRect &r)
{
    return r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 &&
        r.x + r.w <= kScreenWidth && r.y + r.h <= kScreenHeight;
}

CalendarRect readRect(const uint8_t *p)
{
    return {readU16(p), readU16(p + 2), readU16(p + 4), readU16(p + 6)};
}

bool atEntry(const CalendarView &view, int offset)
{
    for (int i = 0; i < view.entryCount; ++i) {
        if (view.entries[i] == offset) {
            return true;
        }
    }
    return false;
}

void drawTickerWindow(U8G2 &canvas, const CalendarView &view, int offset)
{
    const CalendarRect &t = view.ticker;
    const size_t stride = (t.w + 7) / 8;
    const int h = view.stripHeight;
    offset = ((offset % h) + h) % h;
    // The strip wraps, so the viewport shows its tail followed by its head.
    const int first = h - offset < t.h ? h - offset : t.h;
    canvas.drawXBM(t.x, t.y, t.w, first, view.strip + offset * stride);
    for (int y = first; y < t.h; y += h) {
        const int rows = t.h - y < h ? t.h - y : h;
        canvas.drawXBM(t.x, t.y + y, t.w, rows, view.strip);
    }
}

// Validates one delta and returns the byte after it, or nullptr when it runs
// past `end` or writes outside a frame of `frameBytes`.
const uint8_t *checkDelta(const uint8_t *p, const uint8_t *end, size_t frameBytes)
{
    if (end - p < 4) {
        return nullptr;
    }
    const uint32_t length = readU32(p);
    p += 4;
    if (static_cast<size_t>(end - p) < length) {
        return nullptr;
    }
    const uint8_t *deltaEnd = p + length;
    size_t cursor = 0;
    while (p < deltaEnd) {
        if (deltaEnd - p < 4) {
            return nullptr;
        }
        cursor += readU16(p);
        const size_t count = readU16(p + 2);
        p += 4;
        if (static_cast<size_t>(deltaEnd - p) < count || cursor + count > frameBytes) {
            return nullptr;
        }
        cursor += count;
        p += count;
    }
    return deltaEnd;
}

// Applies a delta already accepted by checkDelta; returns the byte after it.
const uint8_t *applyDelta(uint8_t *frame, const uint8_t *p)
{
    const uint8_t *end = p + 4 + readU32(p);
    p += 4;
    size_t cursor = 0;
    while (p < end) {
        cursor += readU16(p);
        const size_t count = readU16(p + 2);
        p += 4;
        for (size_t i = 0; i < count; ++i) {
            frame[cursor + i] ^= p[i];
        }
        cursor += count;
        p += count;
    }
    return end;
}

int positiveIndex(int value, int count)
{
    return ((value % count) + count) % count;
}

void drawBadge(U8G2 &canvas, const CalendarRect &scene, const char *label)
{
    canvas.setFont(u8g2_font_6x10_tr);
    const int w = canvas.getStrWidth(label) + 8;
    const int h = 14;
    const int x = scene.x + 6;
    const int y = scene.y + 6;
    canvas.setDrawColor(0);
    canvas.drawBox(x - 1, y - 1, w + 2, h + 2);
    canvas.setDrawColor(1);
    canvas.drawBox(x, y, w, h);
    canvas.setDrawColor(0);
    canvas.drawStr(x + 4, y + 11, label);
    canvas.setDrawColor(1);
}

void drawPlaceholder(U8G2 &canvas, const char *status)
{
    canvas.setFont(u8g2_font_helvB14_tr);
    const char *title = "NO CALENDAR";
    canvas.drawStr((kScreenWidth - canvas.getStrWidth(title)) / 2, 140, title);
    canvas.setFont(u8g2_font_6x10_tr);
    const char *detail = status == nullptr || status[0] == '\0' ? "WAITING FOR SERVER" : status;
    canvas.drawStr((kScreenWidth - canvas.getStrWidth(detail)) / 2, 165, detail);
}

} // namespace

bool parseCalendarBundle(const uint8_t *data, size_t length, CalendarView *view)
{
    if (data == nullptr || view == nullptr || length < kHeaderSize ||
        memcmp(data, "CAL1", 4) != 0 || readU16(data + 4) != kVersion) {
        return false;
    }

    CalendarView v = {};
    const int modeCount = readU16(data + 6);
    v.fps = readU16(data + 8);
    v.scene = readRect(data + 10);
    v.ticker = readRect(data + 18);
    v.stripHeight = readU16(data + 26);
    v.scrolls = readU16(data + 28) != 0 && v.stripHeight > 0;
    const int entryCount = readU16(data + 30);
    v.id = readU32(data + 32);
    v.defaultMode = readU16(data + 36);
    if (!rectInScreen(v.scene) || !rectInScreen(v.ticker) || v.fps <= 0 ||
        modeCount <= 0 || modeCount > kCalendarMaxModes || v.defaultMode >= modeCount) {
        return false;
    }

    size_t offset = kHeaderSize;
    if (length < offset + entryCount * 2 + modeCount * kModeRecordSize) {
        return false;
    }
    v.entryCount = entryCount < kCalendarMaxEntries ? entryCount : kCalendarMaxEntries;
    for (int i = 0; i < v.entryCount; ++i) {
        v.entries[i] = readU16(data + offset + i * 2);
    }
    offset += entryCount * 2;

    v.modeCount = modeCount;
    for (int i = 0; i < modeCount; ++i) {
        const uint8_t *record = data + offset + i * kModeRecordSize;
        CalendarMode &mode = v.modes[i];
        memcpy(mode.name, record, kModeNameBytes);
        mode.name[kModeNameBytes] = '\0';
        mode.frameCount = readU16(record + 12);
        if (mode.frameCount <= 0) {
            return false;
        }
    }
    offset += modeCount * kModeRecordSize;

    v.frameBytes = xbmBytes(v.scene.w, v.scene.h);
    const size_t baseBytes = xbmBytes(kScreenWidth, kScreenHeight);
    const size_t stripBytes = xbmBytes(v.ticker.w, v.stripHeight);
    if (length < offset + baseBytes + v.frameBytes * modeCount + stripBytes) {
        return false;
    }
    v.base = data + offset;
    offset += baseBytes;
    const uint8_t *loopsEnd = data + length - stripBytes;
    const uint8_t *p = data + offset;
    for (int i = 0; i < modeCount; ++i) {
        CalendarMode &mode = v.modes[i];
        if (static_cast<size_t>(loopsEnd - p) < v.frameBytes) {
            return false;
        }
        mode.keyframe = p;
        p += v.frameBytes;
        mode.deltas = p;
        for (int k = 1; k < mode.frameCount; ++k) {
            p = checkDelta(p, loopsEnd, v.frameBytes);
            if (p == nullptr) {
                return false;
            }
        }
    }
    if (p != loopsEnd) {
        return false;
    }
    v.strip = loopsEnd;
    *view = v;
    return true;
}

const uint8_t *calendarPlayerFrame(
    CalendarPlayer *player,
    const CalendarView &view,
    int mode,
    int frame)
{
    if (player->capacity < view.frameBytes) {
        free(player->scene);
        player->scene = static_cast<uint8_t *>(heap_caps_malloc(view.frameBytes, MALLOC_CAP_8BIT));
        player->capacity = player->scene == nullptr ? 0 : view.frameBytes;
        player->bundle = nullptr;
        if (player->scene == nullptr) {
            return nullptr;
        }
    }
    mode = positiveIndex(mode, view.modeCount);
    const CalendarMode &m = view.modes[mode];
    frame = positiveIndex(frame, m.frameCount);
    const bool same = player->bundle == view.base && player->id == view.id && player->mode == mode;
    if (same && player->frame == frame) {
        return player->scene;
    }
    int from = player->frame;
    if (!same || frame < from) {
        memcpy(player->scene, m.keyframe, view.frameBytes);
        from = 0;
    }
    const uint8_t *delta = m.deltas;
    for (int k = 0; k < frame; ++k) {
        if (k >= from) {
            delta = applyDelta(player->scene, delta);
        } else {
            delta += 4 + readU32(delta);
        }
    }
    player->bundle = view.base;
    player->id = view.id;
    player->mode = mode;
    player->frame = frame;
    return player->scene;
}

int calendarFindMode(const CalendarView &view, const char *name)
{
    if (name == nullptr) {
        return -1;
    }
    for (int i = 0; i < view.modeCount; ++i) {
        if (strcmp(view.modes[i].name, name) == 0) {
            return i;
        }
    }
    return -1;
}

void calendarTickerReset(CalendarTicker *ticker, uint32_t now)
{
    ticker->offset = 0;
    ticker->pauseSteps = kTickerPauseSteps;
    ticker->lastStepMs = now;
}

bool calendarTickerAdvance(CalendarTicker *ticker, const CalendarView &view, uint32_t now)
{
    if (!view.scrolls) {
        return false;
    }
    bool moved = false;
    while (now - ticker->lastStepMs >= kTickerStepMs) {
        ticker->lastStepMs += kTickerStepMs;
        if (ticker->pauseSteps > 0) {
            ticker->pauseSteps -= 1;
            continue;
        }
        ticker->offset = (ticker->offset + 1) % view.stripHeight;
        if (atEntry(view, ticker->offset)) {
            ticker->pauseSteps = kTickerPauseSteps;
        }
        moved = true;
    }
    return moved;
}

void drawCalendar(
    ST7305_U8g2 &display,
    const CalendarView *view,
    const uint8_t *scene,
    int tickerOffset,
    const char *label,
    const char *status,
    bool fullRedraw)
{
    U8G2 &canvas = *display.getU8g2();
    canvas.setMaxClipWindow();
    canvas.setDrawColor(1);
    canvas.setBitmapMode(0);
    if (view == nullptr) {
        canvas.clearBuffer();
        drawPlaceholder(canvas, status);
        canvas.sendBuffer();
        return;
    }

    // Solid XBM blits overwrite every pixel they cover, so partial redraws only
    // need the animated regions.
    if (fullRedraw) {
        canvas.drawXBM(0, 0, kScreenWidth, kScreenHeight, view->base);
    }
    if (scene != nullptr) {
        canvas.drawXBM(view->scene.x, view->scene.y, view->scene.w, view->scene.h, scene);
    }
    if (label != nullptr && label[0] != '\0') {
        drawBadge(canvas, view->scene, label);
    }
    if (view->scrolls) {
        drawTickerWindow(canvas, *view, tickerOffset);
    }
    canvas.sendBuffer();
}
