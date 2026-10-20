#!/bin/sh
set -eu
rm -rf dist
mkdir -p dist/assets dist/.well-known
cp index.html privacidad.html manifest.webmanifest sw.js _headers _redirects dist/
cp -R assets/. dist/assets/
cp -R .well-known/. dist/.well-known/
printf 'Sitio estatico listo en dist/; Pages publicara las funciones de /functions.\n'
