/**
 * SLMP 3E 帧 TCP 一问一答客户端（over TCP, target = GX Simulator3）。
 *
 * 只做"连接 → 发一帧 → 按响应长度字段收齐一帧"的最小传输，帧编解码归
 * core/protocol/slmp3e.ts（纯函数）。设计要点（2026-10-02 实测约束）：
 *
 * - 探针均为一次性连接（connect→write→收一包→end），持久复用未验证——
 *   因此 resolve 以收齐声明长度为准（不等服务端 close），且断线后下次
 *   exchange 透明重连，两种服务端行为都能工作。
 * - 无并发：exchange 重入直接拒绝（gateway 层天然顺序调用）。
 * - 默认目标 127.0.0.1:5511（RSimRun3 监听端口，实测）。
 */
import net from 'node:net'

/** 最小 socket 结构面（测试注入 fake socket；刻意不直接依赖 net.Socket 类型） */
export interface SlmpSocketLike {
  connect(options: { host: string; port: number }, onConnect?: () => void): void
  write(data: Uint8Array): void
  end(): void
  destroy(): void
  on(event: 'connect', cb: () => void): void
  on(event: 'data', cb: (chunk: Buffer) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'error', cb: (err: Error) => void): void
  removeListener(event: 'error', cb: (err: Error) => void): void
}

export interface SlmpClientOptions {
  /** 默认 127.0.0.1 */
  host?: string
  /** 默认 5511（RSimRun3 监听端口，2026-10-02 实测） */
  port?: number
  /** 默认 3000 */
  connectTimeoutMs?: number
  /** 默认 5000 */
  responseTimeoutMs?: number
  /** 测试注入 socket 工厂（默认 net.connect） */
  socketFactory?: () => SlmpSocketLike
}

/** 3E 帧最小长度 = 子头(2) + 访问路径(5) + 数据长度(2)（结束代码尚在其后） */
const FRAME_MIN_LENGTH = 9

interface PendingExchange {
  resolve: (frame: Uint8Array) => void
  reject: (err: Error) => void
}

export class SlmpClient {
  private readonly host: string
  private readonly port: number
  private readonly connectTimeoutMs: number
  private readonly responseTimeoutMs: number
  private readonly socketFactory: () => SlmpSocketLike
  private socket: SlmpSocketLike | null = null
  private pending: PendingExchange | null = null
  private buffer: Buffer = Buffer.alloc(0)

  constructor(options?: SlmpClientOptions) {
    this.host = options?.host ?? '127.0.0.1'
    this.port = options?.port ?? 5511
    this.connectTimeoutMs = options?.connectTimeoutMs ?? 3000
    this.responseTimeoutMs = options?.responseTimeoutMs ?? 5000
    this.socketFactory =
      options?.socketFactory ?? ((): SlmpSocketLike => net.connect({ host: this.host, port: this.port }))
  }

  get connected(): boolean {
    return this.socket !== null
  }

  /**
   * 建立连接（幂等：已连接时直接返回）。连接被拒/超时抛中文错误。
   */
  async connect(): Promise<void> {
    if (this.socket) return
    const socket = this.socketFactory()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`连接 GX Simulator3（${this.host}:${this.port}）超时（${this.connectTimeoutMs}ms）`))
      }, this.connectTimeoutMs)
      const onConnect = (): void => {
        clearTimeout(timer)
        socket.removeListener('error', onError)
        resolve()
      }
      const onError = (err: Error): void => {
        clearTimeout(timer)
        socket.destroy()
        reject(new Error(`无法连接 GX Simulator3（${this.host}:${this.port}）：${err.message}`))
      }
      socket.on('error', onError)
      socket.on('connect', onConnect)
      socket.connect({ host: this.host, port: this.port })
    })
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('close', () => this.onClose())
    socket.on('error', () => this.onClose())
    this.socket = socket
  }

  /**
   * 发送请求帧，收齐一个完整响应帧后 resolve（按子头帧的数据长度字段
   * byte[7..8] 断帧，总长 = 9 + declared）。不等 close——Simulator3 可能
   * 一问一关。断线状态下自动重连。
   */
  async exchange(frame: Uint8Array): Promise<Uint8Array> {
    if (this.pending) {
      throw new Error('上一请求尚未完成，禁止并发调用 exchange')
    }
    if (!this.socket) {
      await this.connect()
    }
    const socket = this.socket!
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        socket.destroy()
        reject(new Error(`等待 Simulator3 响应超时（${this.responseTimeoutMs}ms，${this.host}:${this.port}）`))
      }, this.responseTimeoutMs)
      this.pending = {
        resolve: (done) => {
          clearTimeout(timer)
          resolve(done)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      }
      socket.write(frame)
    })
  }

  /** 关闭连接（幂等） */
  close(): void {
    const socket = this.socket
    this.socket = null
    this.buffer = Buffer.alloc(0)
    if (socket) {
      socket.end()
      socket.destroy()
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length < FRAME_MIN_LENGTH) return
    const declared = this.buffer[7] | (this.buffer[8] << 8)
    const total = FRAME_MIN_LENGTH + declared
    if (this.buffer.length < total) return
    const frame = new Uint8Array(this.buffer.subarray(0, total))
    this.buffer = Buffer.alloc(0)
    const pending = this.pending
    this.pending = null
    pending?.resolve(frame)
  }

  private onClose(): void {
    this.socket = null
    this.buffer = Buffer.alloc(0)
    const pending = this.pending
    this.pending = null
    pending?.reject(new Error(`与 Simulator3 的连接已断开（${this.host}:${this.port}），请求未完成`))
  }
}
