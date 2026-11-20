#pragma once

// Copy this file to config.h. config.h is ignored by git.
// WIFI_SSID "your-ssid" keeps the firmware in DEMO mode and does not join Wi-Fi.

#define WIFI_SSID "your-ssid"
#define WIFI_PASSWORD "your-password"
// Point both URLs at the LAN address of the machine running server/ (HTTP_HOST=0.0.0.0).
#define TRENDING_API_URL "http://192.168.1.10:8787/api/trending.tsv"
// Leave empty to disable the calendar page.
#define CALENDAR_API_URL "http://192.168.1.10:8787/api/calendar/device.bin"
