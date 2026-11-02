<script module lang="ts">
    // Line icons from Lucide (ISC licence), 24 × 24, drawn with the current text colour.
    const PATHS = {
        more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
        x: '<path d="M18 6 6 18M6 6l12 12"/>',
    } as const;

    export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
    let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<!-- The markup comes from the constant table above, never from data. -->
<svg
    class="icon"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false">{@html PATHS[name]}</svg
>
