// Hash routes: #/, #/files, #/activity, #/settings, #/setup/<token>.

const current = () => location.hash.replace(/^#/, "") || "/";

export const route = $state({ path: current() });

window.addEventListener("hashchange", () => (route.path = current()));

export function replace(path: string) {
    history.replaceState(null, "", `${location.pathname}#${path}`);
    route.path = path;
}
