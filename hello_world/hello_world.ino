#include "../client/ST7305_U8g2.h"

ST7305_U8g2 display(11, 12, 5, 40, 41);
U8G2 *canvas = nullptr;

void setup()
{
    Serial.begin(115200);
    delay(3000);
    Serial.println("Display diagnostic starting");

    display.begin(0, U8G2_R1);
    canvas = display.getU8g2();
    canvas->clearBuffer();
    canvas->setDrawColor(1);
    canvas->drawFrame(8, 8, 384, 284);
    canvas->drawBox(20, 20, 360, 8);
    canvas->setFont(u8g2_font_spleen12x24_mf);
    canvas->drawStr(92, 130, "HELLO WORLD");
    canvas->setFont(u8g2_font_9x15_tf);
    canvas->drawStr(96, 164, "ST7305 DISPLAY TEST");
    canvas->setFont(u8g2_font_6x10_tf);
    canvas->drawStr(110, 196, "400 x 300 / GPIO OK");
    canvas->sendBuffer();

    Serial.println("Display diagnostic rendered");
}

void loop()
{
    delay(5000);
    Serial.println("Retrying ST7305 initialization");
    display.fullInit();
    canvas->sendBuffer();
}
