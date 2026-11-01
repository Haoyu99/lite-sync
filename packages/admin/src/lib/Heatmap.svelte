<script lang="ts">
    import { onMount } from "svelte";

    // GitHub-style activity calendar: one column per week (Sunday first), one cell per day.
    // `counts` maps a local day number (days since 1970-01-01 in the viewer's time zone) to changes.
    let {
        counts,
        today,
        selected = null,
        onSelect,
        weeks = 53,
    }: { counts: Map<number, number>; today: number; selected?: number | null; onSelect?: (day: number) => void; weeks?: number } = $props();

    const DAY_MS = 86_400_000;
    const dow = (d: number) => (((d + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
    const at = (d: number) => new Date(d * DAY_MS);

    const start = $derived(today - dow(today) - (weeks - 1) * 7);
    const days = $derived(Array.from({ length: weeks * 7 }, (_, i) => start + i));
    const max = $derived(Math.max(0, ...counts.values()));
    // A month label goes on the column containing that month's first day, so it is the Saturday's month.
    const months = $derived(
        Array.from({ length: weeks }, (_, w) => {
            const sat = at(start + w * 7 + 6);
            return sat.getUTCDate() <= 7 ? `${sat.getUTCMonth() + 1}月` : "";
        })
    );

    function level(n: number): number {
        if (n === 0 || max === 0) return 0;
        const r = n / max;
        return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4;
    }

    function label(d: number, n: number): string {
        const t = at(d);
        return `${t.getUTCFullYear()}年${t.getUTCMonth() + 1}月${t.getUTCDate()}日：${n ? `${n} 次修改` : "没有修改"}`;
    }

    let scroller: HTMLDivElement | undefined = $state();
    onMount(() => {
        // On narrow screens, show the most recent weeks first.
        if (scroller) scroller.scrollLeft = scroller.scrollWidth;
    });
</script>

<div class="heat-scroll" bind:this={scroller}>
    <div class="heat" style="--w: {weeks}">
        <div class="heat-months" aria-hidden="true">
            {#each months as m, i (i)}<span>{m}</span>{/each}
        </div>
        <div class="heat-days" aria-hidden="true">
            <span></span><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span>
        </div>
        <div class="heat-grid">
            {#each days as d (d)}
                {@const n = counts.get(d) ?? 0}
                {#if d > today}
                    <span class="heat-cell future"></span>
                {:else}
                    <button
                        class="heat-cell"
                        data-l={level(n)}
                        aria-pressed={selected === d}
                        aria-label={label(d, n)}
                        title={label(d, n)}
                        onclick={() => onSelect?.(d)}
                    ></button>
                {/if}
            {/each}
        </div>
    </div>
</div>
