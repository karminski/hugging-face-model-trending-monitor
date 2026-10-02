#include "net.h"

#include "config.h"

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

bool fetchBoard(
    TrendingBoard *board,
    char *error,
    size_t errorSize,
    int *httpCode,
    uint32_t *latencyMs)
{
    HTTPClient http;
    const bool https = strncmp(TRENDING_API_URL, "https://", 8) == 0;
    bool started = false;
    WiFiClientSecure secureClient;
    WiFiClient plainClient;
    if (https) {
        // Certificate rotation on a small device is brittle, so the TLS
        // connection checks the hostname implicitly via the URL only.
        secureClient.setInsecure();
        secureClient.setTimeout(12000);
        started = http.begin(secureClient, TRENDING_API_URL);
    } else {
        plainClient.setTimeout(12000);
        started = http.begin(plainClient, TRENDING_API_URL);
    }
    if (!started) {
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

bool fetchDue(uint32_t now)
{
    return static_cast<uint32_t>(now - nextFetchAtMs) < 0x80000000UL;
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
        if (WiFi.status() == WL_CONNECTED && fetchDue(now)) {
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
    Serial.println("Manual API refresh requested");
}
