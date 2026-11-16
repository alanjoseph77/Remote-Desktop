'use strict';
// Maps browser KeyboardEvent.code values to nut-js Key enum names.
// Using `code` (physical key) instead of `key` means layouts work naturally:
// the host's own keyboard layout decides which character is produced.
const map = {
  Escape: 'Escape', Backquote: 'Grave', Minus: 'Minus', Equal: 'Equal',
  Backspace: 'Backspace', Tab: 'Tab', BracketLeft: 'LeftBracket', BracketRight: 'RightBracket',
  Backslash: 'Backslash', IntlBackslash: 'Backslash', CapsLock: 'CapsLock', Semicolon: 'Semicolon',
  Quote: 'Quote', Enter: 'Enter', NumpadEnter: 'Enter', Space: 'Space',
  Comma: 'Comma', Period: 'Period', Slash: 'Slash',
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift',
  ControlLeft: 'LeftControl', ControlRight: 'RightControl',
  AltLeft: 'LeftAlt', AltRight: 'RightAlt',
  MetaLeft: 'LeftSuper', MetaRight: 'RightSuper', OSLeft: 'LeftSuper', OSRight: 'RightSuper',
  ContextMenu: 'Menu',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  PrintScreen: 'Print', ScrollLock: 'ScrollLock', Pause: 'Pause', NumLock: 'NumLock',
  NumpadAdd: 'Add', NumpadSubtract: 'Subtract', NumpadMultiply: 'Multiply', NumpadDivide: 'Divide',
  NumpadDecimal: 'Decimal', NumpadEqual: 'NumPadEqual',
  AudioVolumeMute: 'AudioMute', AudioVolumeDown: 'AudioVolDown', AudioVolumeUp: 'AudioVolUp',
  MediaPlayPause: 'AudioPlay', MediaStop: 'AudioStop', MediaTrackNext: 'AudioNext', MediaTrackPrevious: 'AudioPrev',
};
for (let c = 65; c <= 90; c++) { const L = String.fromCharCode(c); map['Key' + L] = L; }
for (let d = 0; d <= 9; d++) { map['Digit' + d] = 'Num' + d; map['Numpad' + d] = 'NumPad' + d; }
for (let f = 1; f <= 24; f++) map['F' + f] = 'F' + f;

module.exports = map;
