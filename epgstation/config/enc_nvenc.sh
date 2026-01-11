#!/bin/bash

img=jrottenberg/ffmpeg:4.3-nvidia1804
ffmpeg_cmd="docker run --rm --gpus all -u`id -u`:`id -g` -v /home/michaelhsu/Videos2/docker-mirakurun-epgstation/recorded:/app/recorded $img"
$ffmpeg_cmd -c:v mpeg2_cuvid -deint adaptive -drop_second_field 1 -i "$INPUT" -c:v h264_nvenc -vb 3M -rc vbr_hq -c:a aac -b:a 192k -r:a 48000 -ac 2 "$OUTPUT"
