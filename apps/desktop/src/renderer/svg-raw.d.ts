// Vite `?raw` imports: the file's contents as a string. Used to inline vendored
// SVG logos so they tint via currentColor (see assets/logos/).
declare module '*.svg?raw' {
  const content: string;
  export default content;
}
