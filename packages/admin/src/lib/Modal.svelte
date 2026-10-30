<script lang="ts">
    import type { Snippet } from "svelte";

    let {
        open = $bindable(false),
        title,
        children,
        actions,
    }: { open?: boolean; title: string; children: Snippet; actions?: Snippet } = $props();

    let el: HTMLDialogElement | undefined = $state();

    $effect(() => {
        if (!el) return;
        if (open && !el.open) el.showModal();
        else if (!open && el.open) el.close();
    });
</script>

<dialog bind:this={el} class="modal" onclose={() => (open = false)}>
    <h2 class="modal-title">{title}</h2>
    <div class="modal-body">{@render children()}</div>
    {#if actions}
        <div class="modal-actions">{@render actions()}</div>
    {/if}
</dialog>
