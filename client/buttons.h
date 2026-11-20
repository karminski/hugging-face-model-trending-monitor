#pragma once

#include <stdint.h>

enum ButtonAction {
    BUTTON_NONE = 0,
    BUTTON_PREVIOUS_PAGE,
    BUTTON_NEXT_PAGE,
    BUTTON_TOGGLE_DEBUG,
    BUTTON_TOGGLE_MODE,
};

void buttonsBegin();

ButtonAction buttonsPoll(uint32_t now);
