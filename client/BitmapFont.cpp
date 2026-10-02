#include "BitmapFont.h"

#include <pgmspace.h>

namespace {

char normalizeCharacter(const BitmapFont &font, char character)
{
    const uint8_t codepoint = static_cast<uint8_t>(character);
    if (codepoint < font.firstCodepoint || codepoint > font.lastCodepoint) {
        return '?';
    }
    return character;
}

BitmapGlyph readGlyph(const BitmapFont &font, char character)
{
    const uint8_t codepoint =
        static_cast<uint8_t>(normalizeCharacter(font, character));
    BitmapGlyph glyph;
    memcpy_P(
        &glyph,
        &font.glyphs[codepoint - font.firstCodepoint],
        sizeof(glyph));
    return glyph;
}

} // namespace

int bitmapTextWidth(const BitmapFont &font, const char *text)
{
    int lineWidth = 0;
    int maximumWidth = 0;

    while (*text != '\0') {
        if (*text == '\n') {
            maximumWidth = max(maximumWidth, lineWidth);
            lineWidth = 0;
        } else if (*text != '\r') {
            lineWidth += readGlyph(font, *text).advance;
        }
        ++text;
    }

    return max(maximumWidth, lineWidth);
}

void drawBitmapText(
    U8G2 &canvas,
    const BitmapFont &font,
    int x,
    int baseline,
    const char *text)
{
    const int lineStart = x;

    while (*text != '\0') {
        if (*text == '\n') {
            x = lineStart;
            baseline += font.lineHeight;
            ++text;
            continue;
        }
        if (*text == '\r') {
            ++text;
            continue;
        }

        const BitmapGlyph glyph = readGlyph(font, *text);
        if (glyph.width > 0 && glyph.height > 0) {
            canvas.drawXBMP(
                x + glyph.xOffset,
                baseline + glyph.yOffset,
                glyph.width,
                glyph.height,
                font.bitmap + glyph.bitmapOffset);
        }

        x += glyph.advance;
        ++text;
    }
}

void drawCenteredBitmapText(
    U8G2 &canvas,
    const BitmapFont &font,
    int displayWidth,
    int baseline,
    const char *text)
{
    drawBitmapText(
        canvas,
        font,
        (displayWidth - bitmapTextWidth(font, text)) / 2,
        baseline,
        text);
}
