// Ways around the app, filled in by app.js (so views needn't import each other): go to a page, open a side panel
// (people, pins, search) or the picture viewer.
export const nav = {
  go: (_path, _opts) => {},
  panel: (_kind, _opts) => {},
  viewer: (_items, _index) => {},
  newConversation: () => {},
};
