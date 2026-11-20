#pragma once

#include <stddef.h>
#include <stdint.h>

class ST7305_U8g2;

constexpr int kCalendarMaxEntries = 32;
constexpr int kCalendarMaxModes = 8;
constexpr int kCalendarModeNameSize = 13;

struct CalendarRect {
    int x;
    int y;
    int w;
    int h;
};

// One dither rendering of the scene loop: a keyframe followed by
// frameCount - 1 XOR deltas, each turning frame k into frame k + 1.
struct CalendarMode {
    char name[kCalendarModeNameSize];
    int frameCount;
    const uint8_t *keyframe;
    const uint8_t *deltas;
};

// Points into a bundle served by GET /api/calendar/device.bin; it stays valid
// only as long as the buffer it was parsed from.
struct CalendarView {
    uint32_t id;
    int fps;
    CalendarRect scene;
    CalendarRect ticker;
    int stripHeight;
    bool scrolls;
    int entryCount;
    uint16_t entries[kCalendarMaxEntries];
    int modeCount;
    int defaultMode;
    CalendarMode modes[kCalendarMaxModes];
    const uint8_t *base;
    size_t frameBytes;
    const uint8_t *strip;
};

// Decodes scene frames into a buffer of its own; it caches the last frame so
// stepping forward costs one delta.
struct CalendarPlayer {
    uint8_t *scene;
    size_t capacity;
    const uint8_t *bundle;
    uint32_t id;
    int mode;
    int frame;
};

struct CalendarTicker {
    int offset;
    int pauseSteps;
    uint32_t lastStepMs;
};

bool parseCalendarBundle(const uint8_t *data, size_t length, CalendarView *view);

// Index of the mode called `name`, or -1.
int calendarFindMode(const CalendarView &view, const char *name);

// Returns the decoded scene for `frame` of `mode`, or nullptr when the frame
// buffer cannot be allocated. Valid until the next call or bundle swap.
const uint8_t *calendarPlayerFrame(
    CalendarPlayer *player,
    const CalendarView &view,
    int mode,
    int frame);

void calendarTickerReset(CalendarTicker *ticker, uint32_t now);

// Returns true when the offset moved and the ticker needs a redraw.
bool calendarTickerAdvance(CalendarTicker *ticker, const CalendarView &view, uint32_t now);

// `label`, when set, is drawn as a badge in the scene's top-left corner. The
// next scene blit erases it, so callers just stop passing it.
void drawCalendar(
    ST7305_U8g2 &display,
    const CalendarView *view,
    const uint8_t *scene,
    int tickerOffset,
    const char *label,
    const char *status,
    bool fullRedraw);
