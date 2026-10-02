#include "self_test.h"

#include "demo_tsv.h"
#include "trending.h"

#include <stdio.h>
#include <string.h>

namespace {

int failures = 0;
void (*output)(const char *) = nullptr;

void expect(bool condition, const char *file, int line, const char *text)
{
    if (condition || output == nullptr) {
        return;
    }
    char message[160];
    snprintf(message, sizeof(message), "FAIL %s:%d %s", file, line, text);
    output(message);
    failures += 1;
}

bool printable(const char *text)
{
    for (size_t index = 0; text[index] != '\0'; ++index) {
        const unsigned char character = static_cast<unsigned char>(text[index]);
        if (character < 0x20 || character > 0x7E) {
            return false;
        }
    }
    return true;
}

} // namespace

#define EXPECT(condition) expect((condition), __FILE__, __LINE__, #condition)

int runTrendingSelfTest(void (*printLine)(const char *line))
{
    failures = 0;
    output = printLine;

    char compact[16];
    formatCompact(4100000000LL, compact, sizeof(compact));
    EXPECT(strcmp(compact, "4.1B") == 0);
    formatCompact(421000000LL, compact, sizeof(compact));
    EXPECT(strcmp(compact, "421M") == 0);
    formatCompact(23700LL, compact, sizeof(compact));
    EXPECT(strcmp(compact, "23.7k") == 0);
    formatCompact(999LL, compact, sizeof(compact));
    EXPECT(strcmp(compact, "999") == 0);
    formatCompact(1000LL, compact, sizeof(compact));
    EXPECT(strcmp(compact, "1k") == 0);
    formatCompact(1500LL, compact, sizeof(compact));
    EXPECT(strcmp(compact, "1.5k") == 0);
    formatCompact(0LL, compact, sizeof(compact));
    EXPECT(strcmp(compact, "0") == 0);
    formatCompact(-5LL, compact, sizeof(compact));
    EXPECT(strcmp(compact, "-") == 0);

    char clipped[16];
    ellipsizeText("abcdefghijklmnopqrstuvwxyz", clipped, sizeof(clipped), 8);
    EXPECT(strcmp(clipped, "abcdefg~") == 0);

    TrendingModel moved = {};
    char label[8];
    snprintf(moved.movement, sizeof(moved.movement), "UP");
    moved.rankDelta = 5;
    formatMovement(&moved, label, sizeof(label));
    EXPECT(strcmp(label, "UP 5") == 0);
    snprintf(moved.movement, sizeof(moved.movement), "DN");
    moved.rankDelta = -5;
    formatMovement(&moved, label, sizeof(label));
    EXPECT(strcmp(label, "DN 5") == 0);
    snprintf(moved.movement, sizeof(moved.movement), "SAME");
    formatMovement(&moved, label, sizeof(label));
    EXPECT(strcmp(label, "--") == 0);
    snprintf(moved.movement, sizeof(moved.movement), "NEW");
    formatMovement(&moved, label, sizeof(label));
    EXPECT(strcmp(label, "NEW") == 0);

    static char demoText[4096];
    static TrendingBoard board;
    EXPECT(strlen(kDemoTsv) < sizeof(demoText));
    memcpy(demoText, kDemoTsv, strlen(kDemoTsv) + 1);
    EXPECT(parseTrendingTsv(demoText, &board));
    EXPECT(board.count == 10);
    EXPECT(!board.stale);
    EXPECT(strcmp(board.models[0].movement, "NEW") == 0);
    EXPECT(board.models[0].previousRank == 0);
    EXPECT(board.models[1].previousRank == 6);
    EXPECT(board.models[1].rankDelta == 4);
    EXPECT(strcmp(board.models[3].parameters, "") == 0);

    char title[72];
    char meta[80];
    formatModelTitle(&board.models[0], title, sizeof(title));
    formatModelMeta(&board.models[1], meta, sizeof(meta));
    EXPECT(strstr(title, "NEW") != nullptr);
    EXPECT(strchr(title, '~') != nullptr);
    EXPECT(strlen(title) <= 44);
    EXPECT(strstr(meta, "421M") != nullptr);
    EXPECT(strstr(meta, "23.7k") != nullptr);
    EXPECT(strlen(meta) <= 46);
    EXPECT(printable(title));
    EXPECT(printable(meta));

    formatModelMeta(&board.models[3], meta, sizeof(meta));
    EXPECT(strstr(meta, "  -  ") != nullptr);
    formatUtcStamp(board.models[0].updatedAt, compact, sizeof(compact));
    EXPECT(strcmp(compact, "09-29 18:05") == 0);

    static char staleText[512];
    static TrendingBoard stale;
    snprintf(
        staleText,
        sizeof(staleText),
        "v1\t2026-09-30T02:00:00.000Z\t-\tSTALE\n"
        "1\t\tNEW\t\tbad\x01id\tunknown\t\t\t0\t0\n");
    EXPECT(parseTrendingTsv(staleText, &stale));
    EXPECT(stale.stale);
    EXPECT(strcmp(stale.models[0].modelId, "bad?id") == 0);

    char broken[] = "v1\t2026-09-30T02:00:00.000Z\t-\tOK\n1\tNEW\tonly-three\n";
    EXPECT(!parseTrendingTsv(broken, &stale));

    static char extra[4600];
    snprintf(
        extra,
        sizeof(extra),
        "%s11\t\tNEW\t\televenth/model\ttext-generation\t1\t2026-09-30T00:00:00.000Z\t1\t1\n",
        kDemoTsv);
    EXPECT(parseTrendingTsv(extra, &board));
    EXPECT(board.count == 10);
    EXPECT(strcmp(board.models[9].modelId, "legacy/dropped-down") == 0);

    char longId[80];
    memset(longId, 'a', 65);
    longId[65] = '\0';
    char longRow[384];
    snprintf(
        longRow,
        sizeof(longRow),
        "v1\t2026-09-30T02:00:00.000Z\t-\tOK\n1\t\tNEW\t\t%s\ttext\t1\t2026-09-30T00:00:00.000Z\t1\t1\n",
        longId);
    EXPECT(!parseTrendingTsv(longRow, &board));

    DashboardLayout layout = {};
    const bool fits = buildDashboardLayout(300, 31, 24, 7, 21, 16, 5, &layout);
    EXPECT(fits);
    EXPECT(dashboardLayoutFits(&layout, 300, 24, 7, 16, 5));
    EXPECT(layout.titleBaseline < layout.statusBaseline);
    EXPECT(layout.statusBaseline < layout.nameBaseline[0]);
    EXPECT(layout.metaBaseline[4] < layout.footerBaseline);
    EXPECT(!buildDashboardLayout(200, 31, 24, 7, 21, 16, 5, &layout));

    if (printLine != nullptr) {
        printLine(failures == 0 ? "SELFTEST PASS" : "SELFTEST FAIL");
    }
    return failures;
}
