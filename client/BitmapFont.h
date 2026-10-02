#pragma once

#include <Arduino.h>
#include <U8g2lib.h>

struct BitmapGlyph {
    uint32_t bitmapOffset;
    uint8_t width;
    uint8_t height;
    int8_t xOffset;
    int8_t yOffset;
    uint8_t advance;
};

struct BitmapFont {
    const uint8_t *bitmap;
    const BitmapGlyph *glyphs;
    uint8_t firstCodepoint;
    uint8_t lastCodepoint;
    uint8_t lineHeight;
    uint8_t ascent;
    uint8_t descent;
};

int bitmapTextWidth(const BitmapFont &font, const char *text);

void drawBitmapText(
    U8G2 &canvas,
    const BitmapFont &font,
    int x,
    int baseline,
    const char *text);

void drawCenteredBitmapText(
    U8G2 &canvas,
    const BitmapFont &font,
    int displayWidth,
    int baseline,
    const char *text);
