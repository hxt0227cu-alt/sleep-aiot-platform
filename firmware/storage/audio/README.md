# White noise audio files

Put four loopable WAV files in this directory before building/flashing:

- rain.wav -> TOUCH10
- wind.wav -> TOUCH11
- bird.wav -> TOUCH12
- thunder.wav -> TOUCH13

Required format: WAV container, PCM signed 16-bit little-endian, mono, 22050 Hz.
Keep each file short and seamless, about 5 to 10 seconds, because the firmware loops it from SPIFFS.

Touch behavior:
- TOUCH9 short press switches the light scene; long press increases audio volume.
- TOUCH14 short press stops playback; long press decreases audio volume.

The files are packed into the `storage` SPIFFS partition during `idf.py build`.
