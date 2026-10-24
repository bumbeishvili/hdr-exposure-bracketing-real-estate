#!/bin/sh
# Records exiftool's reading of each sample ARW as the reference for test/arw.test.ts.
# Usage: npm run fixtures:exif   (needs exiftool on PATH and ARW files in app-samples/)
set -eu
cd "$(dirname "$0")/.."
out=test/fixtures/exiftool
mkdir -p "$out"
for f in app-samples/*.ARW; do
  exiftool -json -n -a -G1 \
    -System:FileName -System:FileSize -IFD0:Make -IFD0:Model -IFD0:Software -IFD0:Orientation \
    -SubIFD:ImageWidth -SubIFD:ImageHeight -SubIFD:BitsPerSample -SubIFD:Compression \
    -SubIFD:PhotometricInterpretation -SubIFD:SonyRawFileType \
    -SubIFD:CFARepeatPatternDim -SubIFD:CFAPattern2 \
    -SubIFD:BlackLevel -SubIFD:WhiteLevel -SubIFD:WB_RGGBLevels \
    -SubIFD:DefaultCropOrigin -SubIFD:DefaultCropSize -SubIFD:StripOffsets -SubIFD:StripByteCounts \
    -SR2:SR2SubIFDOffset -SR2:SR2SubIFDLength -SR2:SR2SubIFDKey \
    -SR2SubIFD:BlackLevel -SR2SubIFD:WhiteLevel -SR2SubIFD:WB_RGGBLevels -SR2SubIFD:WB_RGGBLevelsAuto \
    -SR2SubIFD:ColorMatrix \
    -ExifIFD:ExposureTime -ExifIFD:FNumber -ExifIFD:ISO -ExifIFD:ExposureCompensation \
    -ExifIFD:DateTimeOriginal -ExifIFD:SubSecTimeOriginal -ExifIFD:FocalLength -ExifIFD:LensModel \
    -ExifIFD:ExposureMode -Sony:SequenceNumber -Sony:ReleaseMode \
    "$f" | sed 's/"SourceFile": "app-samples\//"SourceFile": "/' > "$out/$(basename "${f%.*}").json"
  echo "wrote $out/$(basename "${f%.*}").json"
done
