export class AccountLifecycleGate {
  private resumes = 0;
  private switching = false;
  private switches: Array<() => void> = [];
  private waitingResumes: Array<() => void> = [];

  private drain(): void {
    if (this.switching || this.resumes > 0) return;
    const nextSwitch = this.switches.shift();
    if (nextSwitch) {
      this.switching = true;
      nextSwitch();
      return;
    }
    const resumes = this.waitingResumes.splice(0);
    this.resumes += resumes.length;
    for (const resume of resumes) resume();
  }

  async acquireSwitch(): Promise<() => void> {
    await new Promise<void>((resolve) => {
      this.switches.push(resolve);
      this.drain();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.switching = false;
      this.drain();
    };
  }

  async acquireResume(agentType: string | undefined): Promise<() => void> {
    if (agentType && agentType !== "claude") return () => {};
    if (!this.switching && this.switches.length === 0) {
      this.resumes++;
    } else {
      await new Promise<void>((resolve) => this.waitingResumes.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.resumes--;
      this.drain();
    };
  }

  async resume<T>(agentType: string | undefined, launch: () => Promise<T>): Promise<T> {
    const release = await this.acquireResume(agentType);
    try {
      return await launch();
    } finally {
      release();
    }
  }
}
