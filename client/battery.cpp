#include "battery.h"

#include <Arduino.h>

namespace {

constexpr int kBatteryAdcPin = 4;
constexpr int kSampleCount = 16;
constexpr int kDividerRatio = 3;
constexpr int kEmptyMillivolts = 3000;
constexpr int kFullMillivolts = 4120;

int filteredMillivolts = -1;

} // namespace

void batteryBegin()
{
    pinMode(kBatteryAdcPin, INPUT);
    analogReadResolution(12);
    analogSetPinAttenuation(kBatteryAdcPin, ADC_11db);
}

int batteryReadPercent()
{
    uint32_t sampleTotal = 0;
    for (int sample = 0; sample < kSampleCount; ++sample) {
        sampleTotal += analogReadMilliVolts(kBatteryAdcPin);
        delay(2);
    }

    const int measuredMillivolts =
        static_cast<int>(sampleTotal / kSampleCount) * kDividerRatio;
    if (filteredMillivolts < 0) {
        filteredMillivolts = measuredMillivolts;
    } else {
        filteredMillivolts = (filteredMillivolts * 3 + measuredMillivolts) / 4;
    }

    if (filteredMillivolts <= kEmptyMillivolts) {
        return 0;
    }
    if (filteredMillivolts >= kFullMillivolts) {
        return 100;
    }
    return (filteredMillivolts - kEmptyMillivolts) * 100 /
        (kFullMillivolts - kEmptyMillivolts);
}
