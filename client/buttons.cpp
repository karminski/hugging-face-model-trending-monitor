#include "buttons.h"

#include <Arduino.h>

namespace {

constexpr int kBootButtonPin = 0;
constexpr int kKeyButtonPin = 18;
constexpr uint32_t kDebounceMs = 30;
constexpr uint32_t kLongPressMs = 800;
constexpr uint32_t kDoubleClickMs = 350;
constexpr uint32_t kScanIntervalMs = 5;

struct ButtonState {
    int pin;
    bool rawPressed;
    bool stablePressed;
    bool longHandled;
    uint32_t changedAtMs;
    uint32_t pressedAtMs;
};

ButtonState bootButton = {kBootButtonPin, false, false, false, 0, 0};
ButtonState keyButton = {kKeyButtonPin, false, false, false, 0, 0};
bool keyClickPending = false;
uint32_t keyClickAtMs = 0;
QueueHandle_t actionQueue = nullptr;

ButtonAction pollButton(
    ButtonState &button,
    uint32_t now,
    ButtonAction shortAction,
    ButtonAction longAction)
{
    const bool pressed = digitalRead(button.pin) == LOW;
    if (pressed != button.rawPressed) {
        button.rawPressed = pressed;
        button.changedAtMs = now;
    }

    if (button.stablePressed != button.rawPressed &&
        now - button.changedAtMs >= kDebounceMs) {
        button.stablePressed = button.rawPressed;
        if (button.stablePressed) {
            button.pressedAtMs = now;
            button.longHandled = false;
        } else if (!button.longHandled) {
            return shortAction;
        }
    }

    if (button.stablePressed && !button.longHandled &&
        longAction != BUTTON_NONE &&
        now - button.pressedAtMs >= kLongPressMs) {
        button.longHandled = true;
        return longAction;
    }
    return BUTTON_NONE;
}

ButtonAction scanButtons(uint32_t now)
{
    const ButtonAction bootAction = pollButton(
        bootButton,
        now,
        BUTTON_NEXT_PAGE,
        BUTTON_NONE);
    if (bootAction != BUTTON_NONE) {
        return bootAction;
    }

    const ButtonAction keyAction = pollButton(
        keyButton,
        now,
        BUTTON_PREVIOUS_PAGE,
        BUTTON_TOGGLE_DEBUG);
    if (keyAction == BUTTON_TOGGLE_DEBUG) {
        keyClickPending = false;
        return keyAction;
    }
    if (keyAction == BUTTON_PREVIOUS_PAGE) {
        if (keyClickPending) {
            keyClickPending = false;
            return BUTTON_TOGGLE_MODE;
        }
        keyClickPending = true;
        keyClickAtMs = now;
        return BUTTON_NONE;
    }
    // A single click is only reported once the double-click window has passed
    // without a second press starting.
    if (keyClickPending && !keyButton.stablePressed &&
        now - keyClickAtMs >= kDoubleClickMs) {
        keyClickPending = false;
        return BUTTON_PREVIOUS_PAGE;
    }
    return BUTTON_NONE;
}

// Rendering a frame can block the main loop for well over the debounce time,
// so the pins are sampled on their own task and actions are queued.
void buttonTask(void *parameter)
{
    (void)parameter;
    for (;;) {
        const ButtonAction action = scanButtons(millis());
        if (action != BUTTON_NONE) {
            xQueueSend(actionQueue, &action, 0);
        }
        vTaskDelay(pdMS_TO_TICKS(kScanIntervalMs));
    }
}

} // namespace

void buttonsBegin()
{
    pinMode(kBootButtonPin, INPUT_PULLUP);
    pinMode(kKeyButtonPin, INPUT_PULLUP);
    actionQueue = xQueueCreate(8, sizeof(ButtonAction));
    if (actionQueue == nullptr ||
        xTaskCreate(buttonTask, "buttons", 3072, nullptr, 2, nullptr) != pdPASS) {
        Serial.println("Button task creation failed");
    }
}

ButtonAction buttonsPoll(uint32_t now)
{
    (void)now;
    ButtonAction action = BUTTON_NONE;
    if (actionQueue != nullptr) {
        xQueueReceive(actionQueue, &action, 0);
    }
    return action;
}
