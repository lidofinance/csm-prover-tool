import { Injectable } from '@nestjs/common';
import ora = require('ora-classic');
import { Ora } from 'ora-classic';
import { IncomingHttpHeaders } from 'undici/types/header';
import BodyReadable from 'undici/types/readable';

@Injectable()
export class DownloadProgress {
  private spinner: Ora;

  constructor() {}

  public show(name: string, resp: { body: BodyReadable; headers: IncomingHttpHeaders }): void {
    const totalContentLength = Number(resp.headers['content-length']);
    let downloaded = 0;
    let speed = '0.00';
    let downloadedMb = 0;
    const start = Date.now();
    const dataSize = Number((totalContentLength / 1024 / 1024).toFixed(2));
    this.add(name, dataSize);

    resp.body.on('data', (chunk) => {
      downloaded += chunk.length;
      downloadedMb = Number(downloaded / 1024 / 1024);
      speed = (downloadedMb / ((Date.now() - start) / 1000)).toFixed(2);
      this.spinner.text = `${name} | ${downloadedMb.toFixed(2)} MB / ${dataSize} MB | ${speed} MB/s`;
    });
    resp.body.on('end', () => this.spinner.succeed());
    resp.body.on('error', () => this.spinner.fail());
  }

  private add(name: string, size: number) {
    if (!this.spinner) {
      this.spinner = ora({
        text: `${name} | 0 MB / ${size} MB | 0.00 MB/s️`,
        spinner: 'dots',
      });
    }
    this.spinner.start();
  }
}
