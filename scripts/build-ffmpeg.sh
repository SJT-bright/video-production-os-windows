#!/usr/bin/env bash
set -euo pipefail
# Separate CLI executable: no FFmpeg libraries are linked into the application.
# The unmodified matching source archive is published alongside every App.
archive=${1:?FFmpeg source archive is required}
platform=${2:?darwin or win32 is required}
arch=${3:?arm64 or x64 is required}
output=${4:?output root is required}
expected=8684f4b00f94b85461884c3719382f1261f0d9eb3d59640a1f4ac0873616f968
if command -v sha256sum >/dev/null; then digest=$(sha256sum "$archive" | cut -d' ' -f1); else digest=$(shasum -a 256 "$archive" | cut -d' ' -f1); fi
test "$digest" = "$expected" || { echo 'FFmpeg source checksum mismatch' >&2; exit 1; }
case "$platform-$arch" in darwin-arm64|darwin-x64|win32-x64) ;; *) echo 'Unsupported target' >&2; exit 1;; esac
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
tar -xf "$archive" -C "$stage"
cd "$stage/ffmpeg-6.1.1"
options=(--disable-autodetect --disable-gpl --disable-nonfree --disable-version3 --disable-doc --disable-debug
  --disable-ffplay --disable-ffprobe --disable-network --disable-everything --disable-x86asm
  --enable-ffmpeg --enable-avcodec --enable-avformat --enable-avfilter --enable-swresample --enable-swscale
  --enable-protocol=file,pipe
  --enable-demuxer=mov,matroska,mp3,aac,wav,flac,ogg,avi,mpegts,asf
  --enable-parser=aac,aac_latm,mpegaudio,h264,hevc,mpeg4video,opus,vorbis,flac,ac3
  --enable-decoder=aac,aac_fixed,aac_latm,mp3,mp3float,mp2,mp2float,flac,opus,vorbis,alac,ac3,eac3,wmav1,wmav2,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_u8,h264,hevc,mpeg4,wrapped_avframe
  --enable-encoder=pcm_s16le,aac,mpeg4 --enable-muxer=wav,mov,mp4
  --enable-indev=lavfi --enable-filter=aresample,aformat,anull,atrim,asetpts,null,color,sine)
if [[ "$platform" = darwin ]]; then
  cpu=arm64; [[ "$arch" = x64 ]] && cpu=x86_64
  options+=(--target-os=darwin --arch="$cpu" --cc="clang -arch $cpu" --enable-cross-compile)
else
  options+=(--target-os=mingw32 --arch=x86_64 --cc=gcc --disable-pthreads --enable-w32threads --extra-ldflags=-static)
fi
./configure "${options[@]}" > configure-output.txt
make -j "${VIDEO_OS_BUILD_JOBS:-4}" > build-output.txt 2>&1
mkdir -p "$output/$platform-$arch"
executable=ffmpeg; [[ "$platform" = win32 ]] && executable=ffmpeg.exe
cp "$executable" "$output/$platform-$arch/$executable"
cp COPYING.LGPLv2.1 "$output/$platform-$arch/$executable.LICENSE"
cp LICENSE.md "$output/$platform-$arch/FFmpeg-LICENSE.md"
cp config.h "$output/$platform-$arch/config.h"
cp configure-output.txt "$output/$platform-$arch/configure-output.txt"
cp ffbuild/config.log "$output/$platform-$arch/config.log"
printf '%s\n' 'FFmpeg 6.1.1, Copyright FFmpeg developers' \
  'LGPL-2.1-or-later; unmodified source; separate executable; no external codec libraries.' \
  'Source: https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz' \
  "Source SHA-256: $expected" 'Build recipe: scripts/build-ffmpeg.sh in the v1.3.4 source repository.' \
  'Corresponding source is included as a GitHub Release asset, FFmpeg-6.1.1-source.tar.xz.' \
  > "$output/$platform-$arch/$executable.README"
grep -q '^#define CONFIG_NONFREE 0$' config.h
grep -q '^#define CONFIG_GPL 0$' config.h
chmod +x "$output/$platform-$arch/$executable"
echo "FFMPEG_REDISTRIBUTABLE_BUILD_PASS $platform-$arch"
