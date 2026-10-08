#!/bin/sh

#git clone https://github.com/l3tnun/docker-mirakurun-epgstation.git
#cd docker-mirakurun-epgstation
# only create missing files: this fork tracks its working docker-compose.yml, enc.js and configs;
# the templates are older and overwriting with them breaks encoding and streaming
copy_missing() { [ -e "$2" ] || cp "$1" "$2"; }
copy_missing docker-compose-sample.yml docker-compose.yml
copy_missing epgstation/scripts/enc.js.template epgstation/scripts/enc.js
copy_missing epgstation/config/config.yml.template epgstation/config/config.yml
copy_missing epgstation/config/operatorLogConfig.sample.yml epgstation/config/operatorLogConfig.yml
copy_missing epgstation/config/epgUpdaterLogConfig.sample.yml epgstation/config/epgUpdaterLogConfig.yml
copy_missing epgstation/config/serviceLogConfig.sample.yml epgstation/config/serviceLogConfig.yml
docker-compose run --rm -e SETUP=true mirakurun
