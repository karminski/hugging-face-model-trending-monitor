#include "buttons.h"

#include <Arduino.h>

namespace {

constexpr int kBootButtonPin = 0;
constexpr int kKeyButtonPin = 18;
constexpr uint32_t kDebounceMs = 30;
constexpr uint32_t kLongPressMs = 800;

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

} // namespace

void buttonsBegin()
{
    pinMode(kBootButtonPin, INPUT_PULLUP);
    pinMode(kKeyButtonPin, INPUT_PULLUP);
}

ButtonAction buttonsPoll(uint32_t now)
{
    const ButtonAction bootAction = pollButton(
        bootButton,
        now,
        BUTTON_NEXT_PAGE,
        BUTTON_NONE);
    if (bootAction != BUTTON_NONE) {
        return bootAction;
    }
    return pollButton(
        keyButton,
        now,
        BUTTON_PREVIOUS_PAGE,
        BUTTON_TOGGLE_DEBUG);
}
