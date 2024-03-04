import { Injectable } from '@nestjs/common';
import { MultiBar, Presets, SingleBar } from 'cli-progress';
import { IncomingHttpHeaders } from 'undici/types/header';
import BodyReadable from 'undici/types/readable';

@Injectable()
export class DownloadProgress {
  private multibar: MultiBar;

  constructor() {}

  // TODO: how it works when error occurs from other promises in the same time ?

  public show(name: string, resp: { body: BodyReadable; headers: IncomingHttpHeaders }): void {
    const totalContentLength = Number(resp.headers['content-length']);
    let downloaded = 0;
    let speed = '0.00';
    let downloadedMb = 0;
    let ratio = 0;
    const start = Date.now();
    const bar = this.add(name, Number((totalContentLength / 1024 / 1024).toFixed(2)));

    resp.body.on('data', (chunk) => {
      downloaded += chunk.length;
      ratio = downloaded / totalContentLength;
      downloadedMb = Number(downloaded / 1024 / 1024);
      speed = (downloadedMb / ((Date.now() - start) / 1000)).toFixed(2);
      bar.update(ratio, {
        speed,
        downloaded: downloadedMb.toFixed(2),
        status: '⤵️ ',
      });
    });
    resp.body.on('end', () => renderFinish('✅ Downloaded\n'));
    resp.body.on('error', () => renderFinish('❌ Failed\n'));

    const renderFinish = (status: string) => {
      bar.update(ratio, {
        speed,
        downloaded: downloadedMb.toFixed(2),
        status,
      });
      bar.render();
      bar.stop();
    };
  }

  private add(name: string, size: number): SingleBar {
    if (!this.multibar) {
      this.initMultibar();
    }
    return this.multibar.create(1, 0, { name, size });
  }

  private initMultibar(): void {
    this.multibar = new MultiBar(
      {
        fps: 1,
        hideCursor: true,
        noTTYOutput: true,
        emptyOnZero: true,
        format: ` | {name} |{bar}| {percentage}% || {downloaded} of {size} Mb | Speed: {speed} Mb/s | {status}`,
      },
      Presets.shades_grey,
    );
  }
}
