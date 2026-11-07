// Temporary (test stability follow-ups, round 1; design §3): a page init script for the follow-ups probe workflow. Not
// part of the app or the tests: followups-probe/patch-helpers.mjs adds it to every page of a probe run when
// STARMAP_PROBE_INIT names it, after `window.__stabilityProbeParams = <STARMAP_PROBE_PARAMS>`.
//
// Always: records the page's frame pace (requestAnimationFrame intervals) and long tasks into window.__stabilityProbe.
// Params:
//   gpuLoad { ms, size = 2048, iterations, drawsPerBatch = 1 }: window.__stabilityProbeGpuLoad() (called by the
//     g3-trigger variant as the first thing of screenshotWithObservations) starts a worker that draws a heavy fragment
//     shader into a size x size OffscreenCanvas WebGL2 context, batch after batch, each batch waited for with a fence,
//     for `ms`. The page's main thread does nothing for it: the load is on the GPU process (SwiftShader on CI), where the
//     page's compositing and the screenshot's frame are drawn too. Each batch's time is recorded.
;(() => {
  const params = window.__stabilityProbeParams ?? {}
  const probe = window.__stabilityProbe = { params, timeOrigin: performance.timeOrigin, startedAt: performance.now(), raf: [], longTasks: [], gpu: null }
  const keep = (list, entry, max) => { list.push(entry); if (list.length > max) list.splice(0, list.length - max) }

  let previous
  const frame = (at) => {
    if (previous !== undefined) keep(probe.raf, [Math.round(at), Math.round(at - previous)], 1500)
    previous = at
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) keep(probe.longTasks, [Math.round(entry.startTime), Math.round(entry.duration)], 400)
    }).observe({ type: 'longtask', buffered: true })
  } catch { probe.longTasks = 'unsupported' }

  // The worker's code (serialized with toString; it runs in the worker's global scope).
  function gpuWorker() {
    const NL = String.fromCharCode(10)
    self.onmessage = ({ data }) => {
      const { ms, size = 2048, iterations, drawsPerBatch = 1 } = data
      try {
        const canvas = new OffscreenCanvas(size, size)
        const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false })
        if (!gl) return void self.postMessage({ error: 'no WebGL 2 context in the worker' })
        const shader = (type, text) => {
          const made = gl.createShader(type)
          gl.shaderSource(made, text)
          gl.compileShader(made)
          if (!gl.getShaderParameter(made, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(made))
          return made
        }
        const program = gl.createProgram()
        gl.attachShader(program, shader(gl.VERTEX_SHADER, ['#version 300 es', 'in vec2 p;', 'void main() { gl_Position = vec4(p, 0.0, 1.0); }'].join(NL)))
        gl.attachShader(program, shader(gl.FRAGMENT_SHADER, ['#version 300 es', 'precision highp float;', 'uniform float t;', 'out vec4 colour;',
          'void main() {', '  vec2 q = gl_FragCoord.xy / ' + size + '.0;', '  float a = t;',
          '  for (int i = 0; i < ' + iterations + '; i++) { a = sin(a + q.x * 3.1) * cos(a - q.y * 2.7) + 0.5; }',
          '  colour = vec4(a, q, 1.0);', '}'].join(NL)))
        gl.linkProgram(program)
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(program))
        gl.useProgram(program)
        const buffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
        const at = gl.getAttribLocation(program, 'p')
        gl.enableVertexAttribArray(at)
        gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0)
        const time = gl.getUniformLocation(program, 't')
        gl.viewport(0, 0, size, size)
        const until = performance.now() + ms
        let batches = 0
        const batch = () => {
          if (performance.now() >= until) return void self.postMessage({ done: { batches } })
          const started = performance.now()
          for (let draw = 0; draw < drawsPerBatch; draw++) { gl.uniform1f(time, batches + draw); gl.drawArrays(gl.TRIANGLES, 0, 3) }
          const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
          gl.flush()
          const poll = () => {
            const status = gl.clientWaitSync(sync, 0, 0)
            if (status === gl.TIMEOUT_EXPIRED) return void setTimeout(poll, 5)
            gl.deleteSync(sync)
            batches++
            self.postMessage({ batch: [Math.round(started), Math.round(performance.now() - started), status] })
            batch()
          }
          poll()
        }
        batch()
      } catch (error) { self.postMessage({ error: String(error?.message ?? error) }) }
    }
  }
  window.__stabilityProbeGpuLoad = () => {
    const load = params.gpuLoad
    if (!load || probe.gpu) return probe.gpu
    const gpu = probe.gpu = { calledAt: Math.round(performance.now()), batches: [], done: null, error: null }
    try {
      const url = URL.createObjectURL(new Blob(['(' + gpuWorker.toString() + ')()'], { type: 'text/javascript' }))
      const worker = new Worker(url)
      worker.onmessage = ({ data }) => {
        if (data.batch) keep(gpu.batches, [Math.round(performance.now()), ...data.batch.slice(1)], 2000)
        if (data.done) { gpu.done = { ...data.done, at: Math.round(performance.now()) }; worker.terminate() }
        if (data.error) gpu.error = data.error
      }
      worker.onerror = (event) => { gpu.error = String(event.message ?? 'worker error') }
      worker.postMessage(load)
    } catch (error) { gpu.error = String(error?.message ?? error) }
    return gpu
  }
})()
