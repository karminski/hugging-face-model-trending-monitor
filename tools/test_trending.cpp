#include "../client/self_test.h"

#include <stdio.h>

int main()
{
    const int failures = runTrendingSelfTest([](const char *line) { puts(line); });
    return failures == 0 ? 0 : 1;
}
