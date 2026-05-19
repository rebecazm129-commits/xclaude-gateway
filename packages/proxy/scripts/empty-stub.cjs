// Stub vacio para esbuild --alias. Reemplaza paquetes nativos que el bundle
// del worker NER NO usa (sharp = procesamiento de imagenes; onnxruntime-web
// = runtime WASM/web). transformers hace require("sharp") en module-init de
// su utils/image.js, pero el NER es solo texto y nunca ejecuta el path de
// imagen, asi que un modulo vacio satisface el require sin arrastrar ~30MB
// de binarios nativos al .app. Verificado: el worker bundleado con estos
// alias infiere las mismas 7 entidades que con transformers completo.
module.exports = {};
