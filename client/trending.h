#pragma once

#include <stddef.h>
#include <stdint.h>

static const int kTrendingModelLimit = 10;
static const uint32_t kTrendingRefreshMs = 60UL * 60UL * 1000UL;
static const uint32_t kTrendingRetryMs = 5UL * 60UL * 1000UL;

struct TrendingModel {
    int rank;
    int previousRank;
    int rankDelta;
    char movement[8];
    char modelId[65];
    char pipeline[33];
    char parameters[24];
    char updatedAt[33];
    long long downloads;
    long long likes;
};

struct TrendingBoard {
    char fetchedAt[40];
    char previousFetchedAt[40];
    bool stale;
    int count;
    TrendingModel models[kTrendingModelLimit];
};

struct DashboardLayout {
    int titleBaseline;
    int statusBaseline;
    int nameBaseline[5];
    int metaBaseline[5];
    int footerBaseline;
};

bool parseTrendingTsv(char *mutableText, TrendingBoard *board);

void ellipsizeText(const char *input, char *output, size_t outputSize, size_t maxChars);

void formatCompact(long long value, char *output, size_t outputSize);

void formatUtcStamp(const char *iso, char *output, size_t outputSize);

void formatMovement(const TrendingModel *model, char *output, size_t outputSize);

void formatModelTitle(const TrendingModel *model, char *output, size_t outputSize);

void formatModelMeta(const TrendingModel *model, char *output, size_t outputSize);

bool buildDashboardLayout(
    int panelHeight,
    int titleLineHeight,
    int titleAscent,
    int titleDescent,
    int bodyLineHeight,
    int bodyAscent,
    int bodyDescent,
    DashboardLayout *layout);

bool dashboardLayoutFits(
    const DashboardLayout *layout,
    int panelHeight,
    int titleAscent,
    int titleDescent,
    int bodyAscent,
    int bodyDescent);
