/** Old /chat.html links open the unified page in its chat view, keeping session and tab. */
const from = new URLSearchParams(window.location.search);
const to = new URLSearchParams({ mode: "chat" });
for (const key of ["sid", "tab"]) {
  const value = from.get(key);
  if (value) to.set(key, value);
}
window.location.replace(`/?${to}`);
