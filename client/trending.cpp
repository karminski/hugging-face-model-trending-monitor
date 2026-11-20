#include "trending.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace {

bool copySanitized(char *dest, size_t destSize, const char *source)
{
    size_t written = 0;
    for (size_t index = 0; source[index] != '\0'; ++index) {
        const unsigned char character = static_cast<unsigned char>(source[index]);
        if (written + 1 >= destSize) {
            return false;
        }
        dest[written++] =
            (character >= 0x20 && character <= 0x7E) ? static_cast<char>(character) : '?';
    }
    dest[written] = '\0';
    return true;
}

int splitExact(char *line, char **fields, int expected)
{
    char *cursor = line;
    for (int index = 0; index < expected; ++index) {
        fields[index] = cursor;
        if (index == expected - 1) {
            return strchr(cursor, '\t') == nullptr ? expected : -1;
        }
        char *tab = strchr(cursor, '\t');
        if (tab == nullptr) {
            return -1;
        }
        *tab = '\0';
        cursor = tab + 1;
    }
    return expected;
}

bool parseInt(const char *text, int *value)
{
    if (text == nullptr || text[0] == '\0') {
        return false;
    }
    char *end = nullptr;
    const long parsed = strtol(text, &end, 10);
    if (end == text || *end != '\0' || parsed > 1000000L || parsed < -1000000L) {
        return false;
    }
    *value = static_cast<int>(parsed);
    return true;
}

bool parseOptionalInt(const char *text, int fallback, int *value)
{
    if (text[0] == '\0') {
        *value = fallback;
        return true;
    }
    return parseInt(text, value);
}

bool parseLong(const char *text, long long *value)
{
    if (text == nullptr || text[0] == '\0') {
        return false;
    }
    char *end = nullptr;
    const long long parsed = strtoll(text, &end, 10);
    if (end == text || *end != '\0') {
        return false;
    }
    *value = parsed;
    return true;
}

bool parseOptionalLong(const char *text, long long fallback, long long *value)
{
    if (text[0] == '\0') {
        *value = fallback;
        return true;
    }
    return parseLong(text, value);
}

void formatScaled(long long value, long long unit, const char *suffix, char *output, size_t outputSize)
{
    const long long whole = value / unit;
    const int tenth = static_cast<int>((value % unit) / (unit / 10));
    if (whole >= 100 || tenth == 0) {
        snprintf(output, outputSize, "%lld%s", whole, suffix);
        return;
    }
    snprintf(output, outputSize, "%lld.%d%s", whole, tenth, suffix);
}

bool appendInk(
    int *tops,
    int *bottoms,
    int *count,
    int baseline,
    int ascent,
    int descent,
    int panelHeight)
{
    const int top = baseline - ascent;
    const int bottom = baseline + descent;
    if (top < 0 || bottom > panelHeight || top >= bottom) {
        return false;
    }
    if (*count > 0 && top < bottoms[*count - 1]) {
        return false;
    }
    tops[*count] = top;
    bottoms[*count] = bottom;
    *count += 1;
    return true;
}

} // namespace

bool parseTrendingTsv(char *mutableText, TrendingBoard *board)
{
    if (mutableText == nullptr || board == nullptr) {
        return false;
    }

    memset(board, 0, sizeof(*board));
    char *cursor = mutableText;
    bool headerRead = false;

    while (cursor != nullptr && *cursor != '\0') {
        char *next = strchr(cursor, '\n');
        if (next != nullptr) {
            *next = '\0';
            ++next;
        }
        const size_t length = strlen(cursor);
        if (length > 0 && cursor[length - 1] == '\r') {
            cursor[length - 1] = '\0';
        }
        if (cursor[0] == '\0') {
            cursor = next;
            continue;
        }

        if (!headerRead) {
            char *fields[4];
            if (splitExact(cursor, fields, 4) != 4 || strcmp(fields[0], "v1") != 0) {
                return false;
            }
            if (strcmp(fields[3], "OK") != 0 && strcmp(fields[3], "STALE") != 0) {
                return false;
            }
            if (!copySanitized(board->fetchedAt, sizeof(board->fetchedAt), fields[1]) ||
                !copySanitized(
                    board->previousFetchedAt,
                    sizeof(board->previousFetchedAt),
                    fields[2])) {
                return false;
            }
            board->stale = strcmp(fields[3], "STALE") == 0;
            headerRead = true;
            cursor = next;
            continue;
        }

        if (board->count >= kTrendingModelLimit) {
            cursor = next;
            continue;
        }

        char *fields[10];
        if (splitExact(cursor, fields, 10) != 10) {
            return false;
        }

        TrendingModel *model = &board->models[board->count];
        if (!parseInt(fields[0], &model->rank) || model->rank <= 0 ||
            !parseOptionalInt(fields[1], 0, &model->previousRank) ||
            !copySanitized(model->movement, sizeof(model->movement), fields[2]) ||
            !parseOptionalInt(fields[3], 0, &model->rankDelta)) {
            return false;
        }
        if (strcmp(model->movement, "UP") != 0 && strcmp(model->movement, "DN") != 0 &&
            strcmp(model->movement, "SAME") != 0 && strcmp(model->movement, "NEW") != 0) {
            return false;
        }
        if (!copySanitized(model->modelId, sizeof(model->modelId), fields[4]) ||
            model->modelId[0] == '\0' ||
            !copySanitized(model->pipeline, sizeof(model->pipeline), fields[5]) ||
            !copySanitized(model->parameters, sizeof(model->parameters), fields[6]) ||
            !copySanitized(model->updatedAt, sizeof(model->updatedAt), fields[7]) ||
            !parseOptionalLong(fields[8], 0, &model->downloads) ||
            !parseOptionalLong(fields[9], 0, &model->likes)) {
            return false;
        }
        board->count += 1;
        cursor = next;
    }

    return headerRead && board->count > 0;
}

void ellipsizeText(const char *input, char *output, size_t outputSize, size_t maxChars)
{
    if (outputSize == 0) {
        return;
    }
    if (input == nullptr) {
        output[0] = '\0';
        return;
    }

    size_t limit = maxChars;
    if (limit >= outputSize) {
        limit = outputSize - 1;
    }
    const size_t length = strlen(input);
    if (length <= limit) {
        memcpy(output, input, length + 1);
        return;
    }
    if (limit == 0) {
        output[0] = '\0';
        return;
    }

    const size_t keep = limit - 1;
    memcpy(output, input, keep);
    output[keep] = '~';
    output[keep + 1] = '\0';
}

void formatCompact(long long value, char *output, size_t outputSize)
{
    if (value < 0) {
        snprintf(output, outputSize, "-");
        return;
    }
    if (value >= 1000000000LL) {
        formatScaled(value, 1000000000LL, "B", output, outputSize);
        return;
    }
    if (value >= 1000000LL) {
        formatScaled(value, 1000000LL, "M", output, outputSize);
        return;
    }
    if (value >= 1000LL) {
        formatScaled(value, 1000LL, "k", output, outputSize);
        return;
    }
    snprintf(output, outputSize, "%lld", value);
}

void formatUtcStamp(const char *iso, char *output, size_t outputSize)
{
    if (iso != nullptr && strlen(iso) >= 16 && iso[4] == '-' && iso[7] == '-' &&
        iso[10] == 'T' && iso[13] == ':') {
        snprintf(
            output,
            outputSize,
            "%c%c-%c%c %c%c:%c%c",
            iso[5],
            iso[6],
            iso[8],
            iso[9],
            iso[11],
            iso[12],
            iso[14],
            iso[15]);
        return;
    }
    ellipsizeText(iso == nullptr ? "" : iso, output, outputSize, 16);
}

void formatMovement(const TrendingModel *model, char *output, size_t outputSize)
{
    if (model != nullptr && strcmp(model->movement, "NEW") == 0) {
        snprintf(output, outputSize, "NEW");
        return;
    }
    if (model != nullptr && strcmp(model->movement, "UP") == 0) {
        snprintf(output, outputSize, "UP %d", model->rankDelta);
        return;
    }
    if (model != nullptr && strcmp(model->movement, "DN") == 0) {
        const int delta = model->rankDelta < 0 ? -model->rankDelta : model->rankDelta;
        snprintf(output, outputSize, "DN %d", delta);
        return;
    }
    snprintf(output, outputSize, "--");
}

void formatModelTitle(const TrendingModel *model, char *output, size_t outputSize)
{
    char movement[8];
    char name[40];
    formatMovement(model, movement, sizeof(movement));
    ellipsizeText(model->modelId, name, sizeof(name), 36);
    snprintf(output, outputSize, "%2d %-4s %s", model->rank, movement, name);
}

void formatModelMeta(const TrendingModel *model, char *output, size_t outputSize)
{
    char pipeline[16];
    char parameters[16];
    char updated[20];
    char downloads[16];
    char likes[16];
    long long parameterCount = 0;

    ellipsizeText(model->pipeline, pipeline, sizeof(pipeline), 12);
    if (!parseLong(model->parameters, &parameterCount) || parameterCount < 0) {
        snprintf(parameters, sizeof(parameters), "-");
    } else {
        formatCompact(parameterCount, parameters, sizeof(parameters));
    }
    formatUtcStamp(model->updatedAt, updated, sizeof(updated));
    formatCompact(model->downloads, downloads, sizeof(downloads));
    formatCompact(model->likes, likes, sizeof(likes));
    snprintf(
        output,
        outputSize,
        "%s  %s  %s  %s  %s",
        pipeline,
        parameters,
        updated,
        downloads,
        likes);
}

bool buildDashboardLayout(
    int panelHeight,
    int titleLineHeight,
    int titleAscent,
    int titleDescent,
    int bodyLineHeight,
    int bodyAscent,
    int bodyDescent,
    DashboardLayout *layout)
{
    if (layout == nullptr || titleLineHeight <= 0 || bodyLineHeight <= 0) {
        return false;
    }

    const int contentHeight = titleLineHeight + (bodyLineHeight * 12);
    const int slack = panelHeight - contentHeight;
    const int reservedGaps = 14;
    if (slack < reservedGaps) {
        return false;
    }

    const int top = 2;
    const int bottom = 2;
    const int titleGap = 2;
    const int statusGap = 2;
    const int rowGap = (slack - 10) / 4;
    const int footerGap = 2 + ((slack - 10) % 4);
    if (rowGap < 1) {
        return false;
    }

    int y = top;
    layout->titleBaseline = y + titleAscent;
    y += titleLineHeight + titleGap;
    layout->statusBaseline = y + bodyAscent;
    y += bodyLineHeight + statusGap;

    for (int row = 0; row < 5; ++row) {
        layout->nameBaseline[row] = y + bodyAscent;
        y += bodyLineHeight;
        layout->metaBaseline[row] = y + bodyAscent;
        y += bodyLineHeight;
        if (row < 4) {
            y += rowGap;
        }
    }

    y += footerGap;
    layout->footerBaseline = y + bodyAscent;
    y += bodyLineHeight + bottom;
    if (y > panelHeight) {
        return false;
    }
    return dashboardLayoutFits(
        layout, panelHeight, titleAscent, titleDescent, bodyAscent, bodyDescent);
}

bool dashboardLayoutFits(
    const DashboardLayout *layout,
    int panelHeight,
    int titleAscent,
    int titleDescent,
    int bodyAscent,
    int bodyDescent)
{
    if (layout == nullptr) {
        return false;
    }

    int tops[13];
    int bottoms[13];
    int count = 0;
    if (!appendInk(
            tops,
            bottoms,
            &count,
            layout->titleBaseline,
            titleAscent,
            titleDescent,
            panelHeight)) {
        return false;
    }

    const int baselines[] = {
        layout->statusBaseline,
        layout->nameBaseline[0],
        layout->metaBaseline[0],
        layout->nameBaseline[1],
        layout->metaBaseline[1],
        layout->nameBaseline[2],
        layout->metaBaseline[2],
        layout->nameBaseline[3],
        layout->metaBaseline[3],
        layout->nameBaseline[4],
        layout->metaBaseline[4],
        layout->footerBaseline,
    };
    for (int baseline : baselines) {
        if (!appendInk(tops, bottoms, &count, baseline, bodyAscent, bodyDescent, panelHeight)) {
            return false;
        }
    }
    return count == 13;
}
