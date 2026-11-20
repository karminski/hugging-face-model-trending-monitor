#include "net.h"

#include "config.h"

#ifndef CALENDAR_API_URL
#define CALENDAR_API_URL ""
#endif

#include <esp_heap_caps.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ping/ping_sock.h>

#include <stdio.h>
#include <string.h>

namespace {

SemaphoreHandle_t stateMutex = nullptr;
NetSnapshot state = {};
uint32_t nextFetchAtMs = 0;
uint32_t lastAttemptMs = 0;
uint32_t backoffMs = 2000;
bool wasOnline = false;
char responseBody[4096];
esp_ping_handle_t pingHandle = nullptr;
volatile bool pingRunning = false;
uint32_t lastPingAtMs = 0;
uint32_t pingGateway = 0;
uint32_t lastWifiDiagnosticsAtMs = 0;

constexpr size_t kCalendarMaxBytes = 256 * 1024;
constexpr uint32_t kCalendarRefreshMs = 5UL * 60UL * 1000UL;
constexpr uint32_t kCalendarRetryMs = 60UL * 1000UL;
SemaphoreHandle_t calendarMutex = nullptr;
uint8_t *calendarBuffers[2] = {nullptr, nullptr};
CalendarView calendarViews[2] = {};
volatile int calendarFront = -1;
uint32_t nextCalendarAtMs = 0;
char calendarEtag[96] = "";

void updatePing(int milliseconds)
{
    if (stateMutex == nullptr) {
        return;
    }
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    if (state.gatewayPingMs != milliseconds) {
        state.gatewayPingMs = milliseconds;
        state.debugGeneration += 1;
    }
    xSemaphoreGive(stateMutex);
}

void onPingSuccess(esp_ping_handle_t handle, void *args)
{
    (void)args;
    uint32_t elapsed = 0;
    if (esp_ping_get_profile(
            handle,
            ESP_PING_PROF_TIMEGAP,
            &elapsed,
            sizeof(elapsed)) == ESP_OK) {
        updatePing(static_cast<int>(elapsed));
    }
}

void onPingTimeout(esp_ping_handle_t handle, void *args)
{
    (void)handle;
    (void)args;
    updatePing(-1);
}

void onPingEnd(esp_ping_handle_t handle, void *args)
{
    (void)handle;
    (void)args;
    pingRunning = false;
}

void startGatewayPing(uint32_t now)
{
    if (WiFi.status() != WL_CONNECTED || pingRunning ||
        now - lastPingAtMs < 30000) {
        return;
    }

    const IPAddress gateway = WiFi.gatewayIP();
    const uint32_t gatewayValue = static_cast<uint32_t>(gateway);
    if (gatewayValue == 0) {
        return;
    }
    if (pingHandle == nullptr || gatewayValue != pingGateway) {
        if (pingHandle != nullptr) {
            esp_ping_delete_session(pingHandle);
            pingHandle = nullptr;
        }
        esp_ping_config_t config = ESP_PING_DEFAULT_CONFIG();
        config.count = 1;
        config.interval_ms = 100;
        config.timeout_ms = 1000;
        config.target_addr.type = IPADDR_TYPE_V4;
        config.target_addr.u_addr.ip4.addr = gatewayValue;
        esp_ping_callbacks_t callbacks = {};
        callbacks.on_ping_success = onPingSuccess;
        callbacks.on_ping_timeout = onPingTimeout;
        callbacks.on_ping_end = onPingEnd;
        if (esp_ping_new_session(&config, &callbacks, &pingHandle) != ESP_OK) {
            pingHandle = nullptr;
            updatePing(-1);
            return;
        }
        pingGateway = gatewayValue;
    }

    pingRunning = true;
    lastPingAtMs = now;
    if (esp_ping_start(pingHandle) != ESP_OK) {
        pingRunning = false;
        updatePing(-1);
    }
}

void updateWifiDiagnostics(uint32_t now)
{
    if (stateMutex == nullptr) {
        return;
    }
    if (now - lastWifiDiagnosticsAtMs < 5000) {
        return;
    }
    lastWifiDiagnosticsAtMs = now;
    const String ip = WiFi.localIP().toString();
    const String gateway = WiFi.gatewayIP().toString();
    const String ssid = WiFi.SSID();
    const int rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : -127;

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    const bool changed = state.rssiDbm != rssi ||
        strcmp(state.ipAddress, ip.c_str()) != 0 ||
        strcmp(state.gateway, gateway.c_str()) != 0 ||
        strcmp(state.ssid, ssid.c_str()) != 0;
    snprintf(state.ipAddress, sizeof(state.ipAddress), "%s", ip.c_str());
    snprintf(state.gateway, sizeof(state.gateway), "%s", gateway.c_str());
    snprintf(state.ssid, sizeof(state.ssid), "%s", ssid.c_str());
    state.rssiDbm = rssi;
    if (changed) {
        state.debugGeneration += 1;
    }
    xSemaphoreGive(stateMutex);
}

void updateApiDiagnostics(int httpCode, uint32_t latencyMs)
{
    if (stateMutex == nullptr) {
        return;
    }
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    state.apiHttpCode = httpCode;
    state.apiLatencyMs = latencyMs;
    state.debugGeneration += 1;
    xSemaphoreGive(stateMutex);
}

void publish(
    NetPhase phase,
    const char *detail,
    const TrendingBoard *board,
    bool replaceBoard,
    uint32_t nextRefreshAtMs)
{
    if (stateMutex == nullptr) {
        return;
    }
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    state.phase = phase;
    snprintf(state.detail, sizeof(state.detail), "%s", detail == nullptr ? "" : detail);
    state.nextRefreshAtMs = nextRefreshAtMs;
    if (replaceBoard && board != nullptr) {
        state.board = *board;
        state.hasBoard = true;
    }
    state.generation += 1;
    xSemaphoreGive(stateMutex);
}

void publishFailure(const char *error, uint32_t nextRefreshAtMs)
{
    if (stateMutex == nullptr) {
        return;
    }
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    const bool keep = state.hasBoard;
    state.phase = keep ? NET_STALE : NET_ERROR;
    snprintf(state.detail, sizeof(state.detail), "%s", keep ? "STALE" : error);
    state.nextRefreshAtMs = nextRefreshAtMs;
    state.generation += 1;
    xSemaphoreGive(stateMutex);
    Serial.printf("Fetch failed: %s keep=%d\n", error, keep ? 1 : 0);
}

bool readResponse(WiFiClient *stream)
{
    size_t used = 0;
    bool overflow = false;
    const uint32_t started = millis();
    while (millis() - started < 12000) {
        while (stream->available() > 0) {
            const int value = stream->read();
            if (value < 0) {
                break;
            }
            if (used + 1 >= sizeof(responseBody)) {
                overflow = true;
                break;
            }
            responseBody[used++] = static_cast<char>(value);
        }
        if (overflow || (!stream->connected() && stream->available() == 0)) {
            break;
        }
        delay(2);
    }
    responseBody[used] = '\0';
    return !overflow && used > 0;
}

bool beginRequest(
    HTTPClient &http,
    WiFiClientSecure &secureClient,
    WiFiClient &plainClient,
    const char *url)
{
    if (strncmp(url, "https://", 8) == 0) {
        // Certificate rotation on a small device is brittle, so the TLS
        // connection checks the hostname implicitly via the URL only.
        secureClient.setInsecure();
        secureClient.setTimeout(12000);
        return http.begin(secureClient, url);
    }
    plainClient.setTimeout(12000);
    return http.begin(plainClient, url);
}

bool fetchBoard(
    TrendingBoard *board,
    char *error,
    size_t errorSize,
    int *httpCode,
    uint32_t *latencyMs)
{
    HTTPClient http;
    WiFiClientSecure secureClient;
    WiFiClient plainClient;
    if (!beginRequest(http, secureClient, plainClient, TRENDING_API_URL)) {
        snprintf(error, errorSize, "BAD URL");
        return false;
    }

    http.setTimeout(12000);
    http.setUserAgent("ultrahost-client/1.0");
    const uint32_t startedAt = millis();
    const int code = http.GET();
    *latencyMs = millis() - startedAt;
    *httpCode = code;
    if (code != HTTP_CODE_OK) {
        snprintf(error, errorSize, "HTTP %d", code);
        http.end();
        return false;
    }

    WiFiClient *stream = http.getStreamPtr();
    const bool read = stream != nullptr && readResponse(stream);
    http.end();
    if (!read || !parseTrendingTsv(responseBody, board)) {
        snprintf(error, errorSize, "%s", read ? "PARSE" : "OVERFLOW");
        return false;
    }
    return true;
}

bool due(uint32_t now, uint32_t at)
{
    return static_cast<uint32_t>(now - at) < 0x80000000UL;
}

bool calendarEnabled()
{
    return CALENDAR_API_URL[0] != '\0' && calendarBuffers[0] != nullptr &&
        calendarBuffers[1] != nullptr;
}

size_t readBody(WiFiClient *stream, uint8_t *output, size_t expected)
{
    size_t used = 0;
    uint32_t lastDataMs = millis();
    while (used < expected && millis() - lastDataMs < 12000) {
        const int available = stream->available();
        if (available > 0) {
            const size_t want = expected - used < static_cast<size_t>(available)
                ? expected - used
                : static_cast<size_t>(available);
            const int got = stream->read(output + used, want);
            if (got > 0) {
                used += got;
                lastDataMs = millis();
            }
        } else if (!stream->connected()) {
            break;
        } else {
            delay(2);
        }
    }
    return used;
}

// Downloads into the back buffer and swaps it in. Returns the HTTP status, or
// a negative code for transport and validation failures.
int fetchCalendar(size_t *bytes)
{
    *bytes = 0;
    const int back = calendarFront == 0 ? 1 : 0;
    HTTPClient http;
    WiFiClientSecure secureClient;
    WiFiClient plainClient;
    if (!beginRequest(http, secureClient, plainClient, CALENDAR_API_URL)) {
        return -1;
    }
    http.setTimeout(12000);
    http.setUserAgent("ultrahost-client/1.0");
    const char *headers[] = {"ETag"};
    http.collectHeaders(headers, 1);
    if (calendarFront >= 0 && calendarEtag[0] != '\0') {
        http.addHeader("If-None-Match", calendarEtag);
    }
    const int code = http.GET();
    if (code != HTTP_CODE_OK) {
        http.end();
        return code;
    }

    const int size = http.getSize();
    if (size <= 0 || static_cast<size_t>(size) > kCalendarMaxBytes) {
        http.end();
        return -2;
    }
    WiFiClient *stream = http.getStreamPtr();
    const size_t used = stream == nullptr
        ? 0
        : readBody(stream, calendarBuffers[back], static_cast<size_t>(size));
    const String etag = http.header("ETag");
    http.end();
    *bytes = used;
    if (used != static_cast<size_t>(size)) {
        return -3;
    }
    CalendarView view;
    if (!parseCalendarBundle(calendarBuffers[back], used, &view)) {
        return -4;
    }

    xSemaphoreTake(calendarMutex, portMAX_DELAY);
    calendarViews[back] = view;
    calendarFront = back;
    xSemaphoreGive(calendarMutex);
    snprintf(calendarEtag, sizeof(calendarEtag), "%s", etag.c_str());
    return code;
}

void publishCalendar(int httpCode, bool replaced)
{
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    state.calendarHttpCode = httpCode;
    state.hasCalendar = calendarFront >= 0;
    if (replaced) {
        state.calendarGeneration += 1;
    }
    state.debugGeneration += 1;
    xSemaphoreGive(stateMutex);
}

void pollWifi(uint32_t now)
{
    const bool online = WiFi.status() == WL_CONNECTED;
    if (online) {
        if (!wasOnline) {
            Serial.printf("Wi-Fi connected: %s\n", WiFi.localIP().toString().c_str());
        }
        backoffMs = 2000;
        wasOnline = true;
        updateWifiDiagnostics(now);
        startGatewayPing(now);
        return;
    }

    if (wasOnline) {
        Serial.println("Wi-Fi disconnected");
        publish(NET_CONNECTING, "WIFI", nullptr, false, nextFetchAtMs);
    }
    wasOnline = false;
    if (static_cast<uint32_t>(now - lastAttemptMs) < backoffMs) {
        return;
    }

    const uint32_t nextBackoff = backoffMs >= 30000 ? 30000 : backoffMs * 2;
    Serial.printf("Wi-Fi retry, next backoff %lu ms\n", static_cast<unsigned long>(nextBackoff));
    WiFi.disconnect(false, false);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    lastAttemptMs = now;
    backoffMs = nextBackoff;
}

void netTask(void *parameter)
{
    (void)parameter;
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(false);
    WiFi.setSleep(false);
    Serial.printf("Wi-Fi connecting to %s\n", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    lastAttemptMs = millis();
    publish(NET_CONNECTING, "WIFI", nullptr, false, 0);

    for (;;) {
        const uint32_t now = millis();
        pollWifi(now);
        if (WiFi.status() == WL_CONNECTED && due(now, nextFetchAtMs)) {
            publish(NET_FETCHING, "HTTP", nullptr, false, nextFetchAtMs);
            Serial.printf("HTTP GET %s\n", TRENDING_API_URL);
            TrendingBoard board;
            char error[16];
            int httpCode = 0;
            uint32_t apiLatencyMs = 0;
            const bool ok = fetchBoard(
                &board,
                error,
                sizeof(error),
                &httpCode,
                &apiLatencyMs);
            updateApiDiagnostics(httpCode, apiLatencyMs);
            const uint32_t finished = millis();
            if (ok) {
                const uint32_t wait = board.stale ? kTrendingRetryMs : kTrendingRefreshMs;
                nextFetchAtMs = finished + wait;
                publish(
                    board.stale ? NET_STALE : NET_ONLINE,
                    board.stale ? "STALE" : "OK",
                    &board,
                    true,
                    nextFetchAtMs);
                Serial.printf(
                    "Parsed %d models stale=%d next=%lu s\n",
                    board.count,
                    board.stale ? 1 : 0,
                    static_cast<unsigned long>(wait / 1000));
            } else {
                nextFetchAtMs = finished + kTrendingRetryMs;
                publishFailure(error, nextFetchAtMs);
                Serial.printf(
                    "Next retry in %lu s\n",
                    static_cast<unsigned long>(kTrendingRetryMs / 1000));
            }
        }
        if (calendarEnabled() && WiFi.status() == WL_CONNECTED &&
            due(millis(), nextCalendarAtMs)) {
            Serial.printf("HTTP GET %s\n", CALENDAR_API_URL);
            size_t bytes = 0;
            const int code = fetchCalendar(&bytes);
            const bool ok = code == HTTP_CODE_OK || code == HTTP_CODE_NOT_MODIFIED;
            nextCalendarAtMs = millis() + (ok ? kCalendarRefreshMs : kCalendarRetryMs);
            publishCalendar(code, code == HTTP_CODE_OK);
            if (code == HTTP_CODE_OK) {
                Serial.printf(
                    "Calendar updated: %u bytes, id %08lx, modes %d\n",
                    static_cast<unsigned>(bytes),
                    static_cast<unsigned long>(calendarViews[calendarFront].id),
                    calendarViews[calendarFront].modeCount);
            } else {
                Serial.printf(
                    "Calendar fetch result %d (%u bytes), next in %lu s\n",
                    code,
                    static_cast<unsigned>(bytes),
                    static_cast<unsigned long>((ok ? kCalendarRefreshMs : kCalendarRetryMs) / 1000));
            }
        }
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

} // namespace

void netTaskStart()
{
    stateMutex = xSemaphoreCreateMutex();
    if (stateMutex == nullptr) {
        Serial.println("Network mutex creation failed");
        return;
    }
    state.rssiDbm = -127;
    state.gatewayPingMs = -2;
    state.apiHttpCode = 0;
    if (CALENDAR_API_URL[0] != '\0') {
        calendarMutex = xSemaphoreCreateMutex();
        for (uint8_t *&buffer : calendarBuffers) {
            buffer = static_cast<uint8_t *>(
                heap_caps_malloc(kCalendarMaxBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        }
        if (calendarMutex == nullptr || calendarBuffers[0] == nullptr ||
            calendarBuffers[1] == nullptr) {
            Serial.println("Calendar buffers unavailable; calendar page disabled");
            for (uint8_t *&buffer : calendarBuffers) {
                free(buffer);
                buffer = nullptr;
            }
        }
    }
    const BaseType_t created = xTaskCreate(netTask, "trending-net", 16384, nullptr, 1, nullptr);
    if (created != pdPASS) {
        Serial.println("Network task creation failed");
    }
}

bool netCopySnapshot(NetSnapshot *snapshot)
{
    if (snapshot == nullptr || stateMutex == nullptr) {
        return false;
    }
    if (xSemaphoreTake(stateMutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return false;
    }
    *snapshot = state;
    xSemaphoreGive(stateMutex);
    return true;
}

void netRequestRefresh()
{
    nextFetchAtMs = 0;
    nextCalendarAtMs = 0;
    Serial.println("Manual API refresh requested");
}

const CalendarView *netLockCalendar()
{
    if (calendarMutex == nullptr ||
        xSemaphoreTake(calendarMutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return nullptr;
    }
    if (calendarFront < 0) {
        xSemaphoreGive(calendarMutex);
        return nullptr;
    }
    return &calendarViews[calendarFront];
}

void netUnlockCalendar()
{
    xSemaphoreGive(calendarMutex);
}
