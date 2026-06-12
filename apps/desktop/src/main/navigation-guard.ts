// Defense-in-depth: the renderer must only ever live at the local app bundle
// (file://) or, in dev, the Vite dev server. Any other navigation target — a
// stray/injected link, a window.open — is denied. External links the user asks
// for go through shell.openExternal (IPC), which opens the system browser and
// never navigates the renderer. Pure predicate so it can be unit-tested without
// the Electron app object.
export function isAllowedNavigation(url: string, devRendererUrl: string | undefined): boolean {
  if (url.startsWith('file://')) return true;
  if (devRendererUrl !== undefined && devRendererUrl !== '' && url.startsWith(devRendererUrl)) {
    return true;
  }
  return false;
}
