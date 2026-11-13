export interface ProgressNotice {
    setMessage(message: string): void;
    hide(): void;
}

// Delay progress so short scans stay quiet, and reuse the same notice for the final result.
export class SyncNotice {
    private create: (message: string) => ProgressNotice;
    private notice: ProgressNotice | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private closeTimer: ReturnType<typeof setTimeout> | undefined;
    private message = "";
    private showingProgress = false;
    private updatedAt = 0;
    constructor(create: (message: string) => ProgressNotice) { this.create = create; }

    progress(message: string) {
        this.message = message;
        if (this.showingProgress && this.notice) {
            if (Date.now() - this.updatedAt >= 100) {
                this.notice.setMessage(message);
                this.updatedAt = Date.now();
            }
        }
        else if (!this.timer) this.timer = setTimeout(() => {
            this.timer = undefined;
            clearTimeout(this.closeTimer);
            this.showingProgress = true;
            if (this.notice) this.notice.setMessage(this.message);
            else this.notice = this.create(this.message);
            this.updatedAt = Date.now();
        }, 600);
    }

    finish(message: string | null) {
        clearTimeout(this.timer);
        this.timer = undefined;
        if (!message) {
            if (this.showingProgress) this.clear();
            return;
        }
        this.showingProgress = false;
        if (this.notice) this.notice.setMessage(message);
        else this.notice = this.create(message);
        clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => this.clear(), 6000);
    }

    begin() {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.showingProgress = false;
    }

    clear() {
        clearTimeout(this.timer);
        clearTimeout(this.closeTimer);
        this.timer = undefined;
        this.closeTimer = undefined;
        this.showingProgress = false;
        this.notice?.hide();
        this.notice = null;
    }
}
