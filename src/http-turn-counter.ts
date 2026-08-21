export class HttpTurnCounter {
  private active = 0;

  count(): number {
    return this.active;
  }

  async track(
    run: () => Promise<Response>,
    signal?: AbortSignal,
    platform: NodeJS.Platform = process.platform,
  ): Promise<Response> {
    this.active += 1;
    let released = false;
    let abortListener: (() => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    };

    try {
      const response = await run();
      if (!response.body) {
        release();
        return response;
      }
      if (signal?.aborted) {
        void response.body.cancel(signal.reason).catch(() => {});
        release();
        return response;
      }

      if (platform !== "win32") {
        // Bun's async-pull teardown bug is Windows-only. On Darwin/Linux, preserve the direct
        // pull chain: it keeps HTTP backpressure native and lets a client body cancellation reach
        // the original SSE reader without an eagerly drained tee branch racing the socket writer.
        const reader = response.body.getReader();
        abortListener = () => {
          void reader.cancel(signal?.reason).catch(() => {}).finally(release);
        };
        signal?.addEventListener("abort", abortListener, { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                release();
                controller.close();
                return;
              }
              controller.enqueue(chunk.value);
            } catch (error) {
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Windows-safe Bun#32111 shape: the client gets a native tee branch,
      // never a JS ReadableStream with async pull(). The second branch is consumed only
      // to observe completion. The request signal releases lifecycle ownership immediately
      // when the client disconnects and cancels the observer branch.
      const [clientBody, lifecycleBody] = response.body.tee();
      const reader = lifecycleBody.getReader();
      abortListener = () => {
        void reader.cancel(signal?.reason).catch(() => {});
        void clientBody.cancel(signal?.reason).catch(() => {});
        release();
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      void (async () => {
        try {
          while (!(await reader.read()).done) {
            // Consume eagerly so the lifecycle branch never backpressures the client branch.
          }
        } catch {
          // Stream failure is delivered to the client branch; lifecycle cleanup stays best-effort.
        } finally {
          release();
        }
      })();
      return new Response(clientBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}
