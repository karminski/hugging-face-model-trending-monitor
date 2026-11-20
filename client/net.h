#pragma once

#include <stdint.h>

#include "calendar.h"
#include "trending.h"

enum NetPhase {
    NET_CONNECTING = 0,
    NET_FETCHING,
    NET_ONLINE,
    NET_STALE,
    NET_ERROR,
};

struct NetSnapshot {
    NetPhase phase;
    uint32_t generation;
    uint32_t debugGeneration;
    uint32_t nextRefreshAtMs;
    bool hasBoard;
    char detail[16];
    char ipAddress[16];
    char gateway[16];
    char ssid[33];
    int rssiDbm;
    int gatewayPingMs;
    int apiHttpCode;
    uint32_t apiLatencyMs;
    bool hasCalendar;
    uint32_t calendarGeneration;
    int calendarHttpCode;
    TrendingBoard board;
};

void netTaskStart();

bool netCopySnapshot(NetSnapshot *snapshot);

void netRequestRefresh();

// Returns the current calendar bundle, or nullptr when none has been fetched.
// A non-null result keeps the bundle locked until netUnlockCalendar().
const CalendarView *netLockCalendar();

void netUnlockCalendar();
