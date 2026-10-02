#include "dashboard.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ST7305_U8g2.h"

namespace {

constexpr int kPanelWidth = 400;
constexpr int kMargin = 8;
constexpr int kVisibleCards = 3;
constexpr int kCardTop = 66;
constexpr int kCardStride = kDashboardCardStride;
constexpr int kListBottom = kCardTop + kVisibleCards * kCardStride - 1;

void useTitleFont(U8G2 &canvas)
{
    canvas.setFont(u8g2_font_spleen12x24_mf);
}

void useBodyFont(U8G2 &canvas)
{
    canvas.setFont(u8g2_font_9x15_tf);
}

void useMetaFont(U8G2 &canvas)
{
    canvas.setFont(u8g2_font_6x10_tf);
}

void fitUiText(
    U8G2 &canvas,
    const char *text,
    int maxWidth,
    char *output,
    size_t outputSize)
{
    if (outputSize == 0) {
        return;
    }
    if (text == nullptr) {
        output[0] = '\0';
        return;
    }

    size_t length = 0;
    while (text[length] != '\0' && length + 1 < outputSize) {
        output[length] = text[length];
        ++length;
    }
    output[length] = '\0';
    useBodyFont(canvas);
    if (canvas.getStrWidth(output) <= maxWidth) {
        return;
    }

    while (length > 1) {
        output[length - 1] = '~';
        output[length] = '\0';
        if (canvas.getStrWidth(output) <= maxWidth) {
            return;
        }
        --length;
        output[length] = '\0';
    }
}

void drawIconChip(U8G2 &canvas, int x, int y)
{
    canvas.drawFrame(x + 2, y + 2, 9, 7);
    for (int offset = 3; offset <= 9; offset += 3) {
        canvas.drawPixel(x, y + offset);
        canvas.drawPixel(x + 13, y + offset);
    }
}

void drawIconClock(U8G2 &canvas, int x, int y)
{
    canvas.drawCircle(x + 6, y + 6, 5);
    canvas.drawLine(x + 6, y + 2, x + 6, y + 6);
    canvas.drawLine(x + 6, y + 6, x + 9, y + 7);
}

void drawIconDownload(U8G2 &canvas, int x, int y)
{
    canvas.drawLine(x + 6, y + 1, x + 6, y + 8);
    canvas.drawLine(x + 3, y + 5, x + 6, y + 8);
    canvas.drawLine(x + 9, y + 5, x + 6, y + 8);
    canvas.drawHLine(x + 2, y + 10, 9);
}

void drawIconHeart(U8G2 &canvas, int x, int y)
{
    canvas.drawDisc(x + 4, y + 4, 3);
    canvas.drawDisc(x + 9, y + 4, 3);
    canvas.drawTriangle(x + 1, y + 5, x + 12, y + 5, x + 6, y + 11);
}

void drawTrendIcon(U8G2 &canvas, const TrendingModel &model, int x, int y, bool inverted)
{
    canvas.setDrawColor(inverted ? 0 : 1);
    if (strcmp(model.movement, "NEW") == 0) {
        canvas.drawFrame(x, y, 12, 12);
        canvas.drawLine(x + 3, y + 6, x + 9, y + 6);
        canvas.drawLine(x + 6, y + 3, x + 6, y + 9);
    } else if (strcmp(model.movement, "UP") == 0) {
        canvas.drawTriangle(x + 6, y, x, y + 7, x + 12, y + 7);
        canvas.drawBox(x + 4, y + 6, 5, 6);
    } else if (strcmp(model.movement, "DN") == 0) {
        canvas.drawBox(x + 4, y, 5, 6);
        canvas.drawTriangle(x, y + 5, x + 12, y + 5, x + 6, y + 12);
    } else {
        canvas.drawHLine(x, y + 5, 12);
        canvas.drawHLine(x, y + 8, 12);
    }
    canvas.setDrawColor(1);
}

void drawStatusIcon(U8G2 &canvas, int x, int y, const char *status)
{
    if (status != nullptr && strcmp(status, "OK") == 0) {
        canvas.drawCircle(x + 7, y + 7, 6);
        canvas.drawLine(x + 3, y + 7, x + 6, y + 10);
        canvas.drawLine(x + 6, y + 10, x + 11, y + 4);
        return;
    }
    if (status != nullptr && strcmp(status, "DEMO") == 0) {
        canvas.drawFrame(x + 1, y + 2, 13, 10);
        canvas.drawPixel(x + 4, y + 5);
        canvas.drawPixel(x + 10, y + 5);
        canvas.drawHLine(x + 4, y + 9, 7);
        return;
    }
    canvas.drawTriangle(x + 7, y, x, y + 13, x + 14, y + 13);
    canvas.drawVLine(x + 7, y + 4, 5);
    canvas.drawPixel(x + 7, y + 11);
}

void drawSmallText(U8G2 &canvas, int x, int baseline, const char *text)
{
    useMetaFont(canvas);
    canvas.drawStr(x, baseline, text == nullptr ? "" : text);
}

void drawBodyText(U8G2 &canvas, int x, int baseline, const char *text)
{
    useBodyFont(canvas);
    canvas.drawStr(x, baseline, text == nullptr ? "" : text);
}

void drawTitleText(U8G2 &canvas, int x, int baseline, const char *text)
{
    useTitleFont(canvas);
    canvas.drawStr(x, baseline, text == nullptr ? "" : text);
}

void drawButtonHint(
    U8G2 &canvas,
    int x,
    const char *label,
    bool filled,
    int arrowDirection = 0)
{
    constexpr int width = 48;
    constexpr int height = 11;
    if (filled) {
        canvas.drawBox(x, 0, width, height);
        canvas.setDrawColor(0);
    } else {
        canvas.drawFrame(x, 0, width, height);
        canvas.setDrawColor(1);
    }
    useMetaFont(canvas);
    const int labelWidth = canvas.getStrWidth(label);
    if (arrowDirection != 0) {
        constexpr int arrowWidth = 7;
        constexpr int arrowGap = 3;
        const int gap = labelWidth > 0 ? arrowGap : 0;
        const int contentWidth = arrowWidth + gap + labelWidth;
        const int arrowX = x + (width - contentWidth) / 2;
        if (arrowDirection < 0) {
            canvas.drawTriangle(arrowX, 5, arrowX + 7, 1, arrowX + 7, 9);
        } else {
            canvas.drawTriangle(arrowX + 7, 5, arrowX, 1, arrowX, 9);
        }
        if (labelWidth > 0) {
            canvas.drawStr(arrowX + arrowWidth + gap, 9, label);
        }
    } else {
        canvas.drawStr(x + (width - labelWidth) / 2, 9, label);
    }
    canvas.setDrawColor(1);
}

void drawButtonHints(U8G2 &canvas, bool debugMode)
{
    if (debugMode) {
        drawButtonHint(canvas, 134, "EXIT/DE", true);
        drawButtonHint(canvas, 186, "PWR", false);
        drawButtonHint(canvas, 238, "RETRY", true);
        return;
    }
    drawButtonHint(canvas, 134, "/ DE", true, -1);
    drawButtonHint(canvas, 186, "PWR", false);
    drawButtonHint(canvas, 238, "", true, 1);
}

void drawBatteryHud(U8G2 &canvas, int batteryPercent)
{
    constexpr int width = 60;
    constexpr int height = 11;
    const int x = kPanelWidth - kMargin - width;
    char label[12];
    snprintf(label, sizeof(label), "BAT %d%%", batteryPercent);
    canvas.drawBox(x, 0, width, height);
    canvas.setDrawColor(0);
    useMetaFont(canvas);
    const int labelWidth = canvas.getStrWidth(label);
    canvas.drawStr(x + (width - labelWidth) / 2, 9, label);
    canvas.setDrawColor(1);
}

void drawRankBadge(U8G2 &canvas, const TrendingModel &model, int top)
{
    canvas.drawBox(kMargin, top, 42, 58);
    canvas.setDrawColor(0);
    char rank[4];
    snprintf(rank, sizeof(rank), "%02d", model.rank);
    useTitleFont(canvas);
    const int rankWidth = canvas.getStrWidth(rank);
    drawTitleText(canvas, kMargin + (42 - rankWidth) / 2, top + 25, rank);
    drawTrendIcon(canvas, model, kMargin + 15, top + 39, true);
    canvas.setDrawColor(1);
}

void formatTrendLabel(const TrendingModel &model, char *output, size_t outputSize)
{
    if (strcmp(model.movement, "NEW") == 0) {
        snprintf(output, outputSize, "NEW");
    } else if (strcmp(model.movement, "SAME") == 0) {
        snprintf(output, outputSize, "SAME");
    } else {
        const int absolute = model.rankDelta < 0 ? -model.rankDelta : model.rankDelta;
        snprintf(output, outputSize, "%s %d", model.movement, absolute);
    }
}

void drawModelCard(U8G2 &canvas, const TrendingModel &model, int top)
{
    drawRankBadge(canvas, model, top);
    canvas.drawHLine(56, top, kPanelWidth - 64);

    char name[48];
    char trend[10];
    formatTrendLabel(model, trend, sizeof(trend));
    useMetaFont(canvas);
    const int trendWidth = canvas.getStrWidth(trend);
    fitUiText(
        canvas,
        model.modelId,
        kPanelWidth - 76 - trendWidth,
        name,
        sizeof(name));
    drawBodyText(canvas, 56, top + 18, name);
    drawSmallText(canvas, kPanelWidth - kMargin - trendWidth, top + 17, trend);

    char pipeline[30];
    ellipsizeText(model.pipeline, pipeline, sizeof(pipeline), 28);
    drawSmallText(canvas, 56, top + 32, pipeline);

    char parameters[12];
    char updated[16];
    char downloads[12];
    char likes[12];
    long long parameterCount = -1;
    if (model.parameters[0] != '\0') {
        parameterCount = strtoll(model.parameters, nullptr, 10);
    }
    formatCompact(parameterCount, parameters, sizeof(parameters));
    formatUtcStamp(model.updatedAt, updated, sizeof(updated));
    formatCompact(model.downloads, downloads, sizeof(downloads));
    formatCompact(model.likes, likes, sizeof(likes));

    const int metricY = top + 42;
    drawIconChip(canvas, 56, metricY);
    drawSmallText(canvas, 71, top + 53, parameters);
    drawIconClock(canvas, 111, metricY);
    drawSmallText(canvas, 125, top + 53, updated);
    drawIconDownload(canvas, 207, metricY);
    drawSmallText(canvas, 221, top + 53, downloads);
    drawIconHeart(canvas, 293, metricY);
    drawSmallText(canvas, 309, top + 53, likes);
}

void drawHeader(
    U8G2 &canvas,
    const TrendingBoard *board,
    bool hasBoard,
    const char *status,
    int batteryPercent)
{
    drawButtonHints(canvas, false);
    drawBatteryHud(canvas, batteryPercent);
    drawTitleText(canvas, kMargin, 39, "HF / TRENDING");
    canvas.drawBox(kMargin, 45, 286, 4);
    canvas.drawBox(306, 45, 86, 4);

    char fetched[20];
    if (hasBoard && board != nullptr) {
        formatUtcStamp(board->fetchedAt, fetched, sizeof(fetched));
    } else {
        snprintf(fetched, sizeof(fetched), "NO DATA");
    }
    drawSmallText(canvas, kMargin, 62, "MODEL INTELLIGENCE / TOP 10");
    drawSmallText(canvas, 221, 62, fetched);
    drawStatusIcon(canvas, 326, 50, status);
    drawSmallText(canvas, 344, 62, status);
}

void drawFooter(U8G2 &canvas, int itemIndex, int itemCount, const char *footerRight)
{
    constexpr int kMarkPitch = 12;
    constexpr int kMarkWidth = 8;
    const int footerY = 270;
    const int marks = itemCount < 0 ? 0 : itemCount;
    for (int index = 0; index < marks; ++index) {
        const int x = kMargin + index * kMarkPitch;
        if (index == itemIndex) {
            canvas.drawBox(x, footerY, kMarkWidth, 7);
        } else {
            canvas.drawFrame(x, footerY, kMarkWidth, 7);
        }
    }

    char pageLabel[16];
    snprintf(
        pageLabel,
        sizeof(pageLabel),
        "%02d/%02d",
        itemCount == 0 ? 0 : itemIndex + 1,
        itemCount);
    drawSmallText(canvas, kMargin + marks * kMarkPitch + 6, 278, pageLabel);
    const char *right = footerRight == nullptr ? "" : footerRight;
    useMetaFont(canvas);
    const int width = canvas.getStrWidth(right);
    drawSmallText(canvas, kPanelWidth - kMargin - width, 278, right);
    canvas.drawHLine(kMargin, 286, kPanelWidth - (kMargin * 2));
    drawSmallText(canvas, kMargin, 298, "[HF-01]  LIVE MODEL SIGNAL");
}

} // namespace

void drawDashboard(
    ST7305_U8g2 &display,
    const TrendingBoard *board,
    bool hasBoard,
    const char *status,
    int originIndex,
    int pixelOffset,
    const char *footerRight,
    int batteryPercent)
{
    U8G2 &canvas = *display.getU8g2();
    const int itemCount = hasBoard && board != nullptr ? board->count : 0;
    if (itemCount <= 0) {
        originIndex = 0;
        pixelOffset = 0;
    } else {
        originIndex %= itemCount;
        if (originIndex < 0) {
            originIndex += itemCount;
        }
        if (pixelOffset < 0) {
            pixelOffset = 0;
        }
        if (pixelOffset >= kCardStride) {
            pixelOffset = kCardStride - 1;
        }
    }

    canvas.setMaxClipWindow();
    canvas.clearBuffer();
    canvas.setDrawColor(1);
    drawHeader(
        canvas,
        board,
        hasBoard,
        status == nullptr ? "" : status,
        batteryPercent);

    if (itemCount > 0) {
        canvas.setClipWindow(0, kCardTop, kPanelWidth - 1, kListBottom);
        const int cardsToDraw = pixelOffset == 0 ? kVisibleCards : kVisibleCards + 1;
        for (int row = 0; row < cardsToDraw; ++row) {
            const int index = (originIndex + row) % itemCount;
            drawModelCard(
                canvas,
                board->models[index],
                kCardTop + row * kCardStride - pixelOffset);
        }
        canvas.setMaxClipWindow();
    }

    int shownIndex = originIndex;
    if (itemCount > 1 && pixelOffset * 2 >= kCardStride) {
        shownIndex = (originIndex + 1) % itemCount;
    }
    drawFooter(canvas, shownIndex, itemCount, footerRight);
    canvas.sendBuffer();
}

void drawDebugDashboard(
    ST7305_U8g2 &display,
    const NetSnapshot &snapshot,
    uint32_t manualPauseRemainingMs,
    int batteryPercent)
{
    U8G2 &canvas = *display.getU8g2();
    canvas.clearBuffer();
    canvas.setDrawColor(1);

    drawButtonHints(canvas, true);
    drawBatteryHud(canvas, batteryPercent);
    drawTitleText(canvas, kMargin, 39, "SYSTEM / DEBUG");
    canvas.drawBox(kMargin, 45, 286, 4);
    canvas.drawBox(306, 45, 86, 4);
    drawStatusIcon(canvas, 326, 50, snapshot.detail);
    drawSmallText(canvas, 344, 62, snapshot.detail);
    drawSmallText(canvas, kMargin, 62, "DEVICE TELEMETRY / LIVE");

    canvas.drawBox(kMargin, 69, 94, 27);
    canvas.setDrawColor(0);
    drawBodyText(canvas, 18, 88, "NETWORK");
    canvas.setDrawColor(1);
    drawSmallText(canvas, 115, 78, "IP ADDRESS");
    drawBodyText(
        canvas,
        115,
        95,
        snapshot.ipAddress[0] == '\0' ? "0.0.0.0" : snapshot.ipAddress);

    drawSmallText(canvas, kMargin, 114, "SSID");
    char ssid[44];
    fitUiText(canvas, snapshot.ssid, 270, ssid, sizeof(ssid));
    drawBodyText(canvas, kMargin, 135, ssid[0] == '\0' ? "NOT CONNECTED" : ssid);
    char rssi[24];
    snprintf(rssi, sizeof(rssi), "%d dBm", snapshot.rssiDbm);
    drawSmallText(canvas, 304, 114, "SIGNAL");
    drawBodyText(canvas, 304, 135, rssi);

    canvas.drawBox(kMargin, 151, 94, 27);
    canvas.setDrawColor(0);
    drawBodyText(canvas, 18, 170, "ROUTE");
    canvas.setDrawColor(1);
    drawSmallText(canvas, 115, 160, "GATEWAY");
    drawBodyText(
        canvas,
        115,
        177,
        snapshot.gateway[0] == '\0' ? "0.0.0.0" : snapshot.gateway);
    char ping[24];
    if (snapshot.gatewayPingMs >= 0) {
        snprintf(ping, sizeof(ping), "%d ms", snapshot.gatewayPingMs);
    } else if (snapshot.gatewayPingMs == -1) {
        snprintf(ping, sizeof(ping), "TIMEOUT");
    } else {
        snprintf(ping, sizeof(ping), "WAIT");
    }
    drawSmallText(canvas, kMargin, 196, "GATEWAY PING");
    drawBodyText(canvas, 115, 199, ping);

    canvas.drawBox(kMargin, 212, 94, 27);
    canvas.setDrawColor(0);
    drawBodyText(canvas, 18, 231, "API");
    canvas.setDrawColor(1);
    char api[40];
    if (snapshot.apiHttpCode == 200) {
        snprintf(api, sizeof(api), "HTTP 200 / %lu ms",
            static_cast<unsigned long>(snapshot.apiLatencyMs));
    } else if (snapshot.apiHttpCode == 0) {
        snprintf(api, sizeof(api), "WAITING");
    } else {
        snprintf(api, sizeof(api), "HTTP %d / %lu ms",
            snapshot.apiHttpCode,
            static_cast<unsigned long>(snapshot.apiLatencyMs));
    }
    drawSmallText(canvas, 115, 221, "REQUEST STATUS");
    drawBodyText(canvas, 115, 238, api);
    drawSmallText(canvas, kMargin, 257, "ENDPOINT  hf-trending.karminski.workers.dev");

    canvas.drawHLine(kMargin, 269, kPanelWidth - (kMargin * 2));
    char pause[32];
    if (manualPauseRemainingMs > 0) {
        snprintf(
            pause,
            sizeof(pause),
            "AUTO HOLD %lum",
            static_cast<unsigned long>((manualPauseRemainingMs + 59999) / 60000));
    } else {
        snprintf(pause, sizeof(pause), "AUTO ACTIVE");
    }
    drawSmallText(canvas, kMargin, 282, "KEY EXIT  BOOT RETRY");
    useMetaFont(canvas);
    const int pauseWidth = canvas.getStrWidth(pause);
    drawSmallText(canvas, kPanelWidth - kMargin - pauseWidth, 282, pause);
    drawSmallText(canvas, kMargin, 297, "HOLD KEY: EXIT DEBUG");
    canvas.sendBuffer();
}
