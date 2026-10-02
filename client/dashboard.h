#pragma once

#include <stdint.h>

#include "net.h"
#include "trending.h"

class ST7305_U8g2;

constexpr int kDashboardCardStride = 65;

void drawDashboard(
    ST7305_U8g2 &display,
    const TrendingBoard *board,
    bool hasBoard,
    const char *status,
    int originIndex,
    int pixelOffset,
    const char *footerRight,
    int batteryPercent);

void drawDebugDashboard(
    ST7305_U8g2 &display,
    const NetSnapshot &snapshot,
    uint32_t manualPauseRemainingMs,
    int batteryPercent);
