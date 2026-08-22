#pragma once

#include <Arduino.h>

struct ProcessResult {
  bool ok;
  int count;
  String error;
};

enum ControlSource : uint8_t;

ProcessResult processPinSetup(const String& body, ControlSource src);
ProcessResult processAction(const String& body, ControlSource src);
