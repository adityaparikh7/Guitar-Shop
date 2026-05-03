/**
 * AudioBridge — Native macOS audio capture using Core Audio.
 *
 * Uses AVAudioEngine to capture audio from a specific USB device and channel,
 * then streams Float32 PCM to the browser via WebSocket on localhost:9876.
 *
 * Also serves a simple HTTP endpoint for device enumeration:
 *   GET /devices → JSON array of audio input devices with channel info
 *
 * Compile:
 *   swiftc -O AudioBridge.swift -o AudioBridge \
 *     -framework AVFoundation -framework CoreAudio -framework Network
 *
 * Usage:
 *   ./AudioBridge [--device <id>] [--channel <n>] [--port <port>]
 */

import Foundation
import AVFoundation
import CoreAudio
import Network

// MARK: - Core Audio Device Enumeration

struct AudioDeviceInfo: Codable {
    let id: UInt32
    let uid: String
    let name: String
    let inputChannels: Int
    let sampleRate: Double
}

func getAudioInputDevices() -> [AudioDeviceInfo] {
    var propertyAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    var dataSize: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject),
        &propertyAddress, 0, nil, &dataSize
    )
    guard status == noErr else { return [] }

    let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
    var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)
    status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &propertyAddress, 0, nil, &dataSize, &deviceIDs
    )
    guard status == noErr else { return [] }

    var results: [AudioDeviceInfo] = []

    for deviceID in deviceIDs {
        // Check input channels
        var inputAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )

        var bufferListSize: UInt32 = 0
        status = AudioObjectGetPropertyDataSize(deviceID, &inputAddress, 0, nil, &bufferListSize)
        guard status == noErr, bufferListSize > 0 else { continue }

        let bufferListPtr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
        defer { bufferListPtr.deallocate() }

        // Need raw allocation for variable-length AudioBufferList
        let rawPtr = UnsafeMutableRawPointer.allocate(byteCount: Int(bufferListSize), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { rawPtr.deallocate() }

        status = AudioObjectGetPropertyData(deviceID, &inputAddress, 0, nil, &bufferListSize, rawPtr)
        guard status == noErr else { continue }

        let bufferList = rawPtr.assumingMemoryBound(to: AudioBufferList.self).pointee
        let bufferCount = Int(bufferList.mNumberBuffers)

        // Count total input channels across all buffers
        var totalInputChannels = 0
        if bufferCount > 0 {
            withUnsafePointer(to: bufferList.mBuffers) { firstBufferPtr in
                let buffers = UnsafeBufferPointer(start: firstBufferPtr, count: bufferCount)
                for buffer in buffers {
                    totalInputChannels += Int(buffer.mNumberChannels)
                }
            }
        }

        // Skip devices with no input channels
        guard totalInputChannels > 0 else { continue }

        // Get device name
        var nameAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceNameCFString,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var nameRef: CFString = "" as CFString
        var nameSize = UInt32(MemoryLayout<CFString>.size)
        AudioObjectGetPropertyData(deviceID, &nameAddress, 0, nil, &nameSize, &nameRef)
        let name = nameRef as String

        // Get device UID
        var uidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uidRef: CFString = "" as CFString
        var uidSize = UInt32(MemoryLayout<CFString>.size)
        AudioObjectGetPropertyData(deviceID, &uidAddress, 0, nil, &uidSize, &uidRef)
        let uid = uidRef as String

        // Get nominal sample rate
        var srAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var sampleRate: Float64 = 48000.0
        var srSize = UInt32(MemoryLayout<Float64>.size)
        AudioObjectGetPropertyData(deviceID, &srAddress, 0, nil, &srSize, &sampleRate)

        results.append(AudioDeviceInfo(
            id: deviceID,
            uid: uid,
            name: name,
            inputChannels: totalInputChannels,
            sampleRate: sampleRate
        ))
    }

    return results
}

func findDeviceID(byId targetId: UInt32) -> AudioDeviceID? {
    let devices = getAudioInputDevices()
    return devices.first(where: { $0.id == targetId })?.id
}

// MARK: - Audio Capture Engine

class AudioCapture {
    let engine = AVAudioEngine()
    var selectedDeviceID: AudioDeviceID = 0
    var selectedChannel: Int = 0
    var onAudioBuffer: (([Float]) -> Void)?

    private var isCapturing = false

    func listDevices() -> [AudioDeviceInfo] {
        return getAudioInputDevices()
    }

    func start(deviceID: AudioDeviceID, channel: Int) throws {
        stop()

        selectedDeviceID = deviceID
        selectedChannel = channel

        // Set the input device on the engine's input node
        let inputNode = engine.inputNode
        var deviceIDValue = deviceID

        // Set the device ID on the audio unit
        let auUnit = inputNode.audioUnit!
        let status = AudioUnitSetProperty(
            auUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceIDValue,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )

        guard status == noErr else {
            throw NSError(domain: "AudioBridge", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "Failed to set input device (error \(status))"])
        }

        // Get device info for channel count
        let devices = getAudioInputDevices()
        let deviceInfo = devices.first(where: { $0.id == deviceID })
        let channelCount = deviceInfo?.inputChannels ?? 2

        print("[AudioBridge] Device has \(channelCount) input channels, selecting channel \(channel + 1)")

        // Set channel map to isolate the requested channel
        // The channel map array: index = app bus channel, value = hardware channel
        var channelMap: [Int32] = [Int32(channel)]
        let mapSize = UInt32(channelMap.count * MemoryLayout<Int32>.size)
        let mapStatus = AudioUnitSetProperty(
            auUnit,
            kAudioOutputUnitProperty_ChannelMap,
            kAudioUnitScope_Output,
            1, // Element 1 = input element
            &channelMap,
            mapSize
        )

        if mapStatus != noErr {
            print("[AudioBridge] Warning: Could not set channel map (error \(mapStatus)), using default mapping")
        }

        // Get the hardware format after device change
        let hwFormat = inputNode.outputFormat(forBus: 0)
        print("[AudioBridge] Hardware format: \(hwFormat)")

        // Install a tap to capture audio — use 64-sample buffer for minimal latency.
        // Passing nil for format lets the engine use the node's native format safely.
        inputNode.installTap(onBus: 0, bufferSize: 64, format: nil) { [weak self] buffer, _ in
            guard let self = self,
                  let channelData = buffer.floatChannelData?[0] else { return }
            let frameCount = Int(buffer.frameLength)
            let samples = Array(UnsafeBufferPointer(start: channelData, count: frameCount))
            self.onAudioBuffer?(samples)
        }

        try engine.start()
        isCapturing = true

        print("[AudioBridge] Capturing from device \(deviceID) channel \(channel + 1) at \(hwFormat.sampleRate)Hz")
    }

    func stop() {
        if isCapturing {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            isCapturing = false
            print("[AudioBridge] Stopped capture")
        }
    }

    func switchChannel(_ channel: Int) throws {
        if isCapturing {
            try start(deviceID: selectedDeviceID, channel: channel)
        } else {
            selectedChannel = channel
        }
    }

    func getSampleRate() -> Double {
        return engine.inputNode.outputFormat(forBus: 0).sampleRate
    }
}

// MARK: - WebSocket + HTTP Server

class BridgeServer {
    let capture = AudioCapture()
    var listener: NWListener?
    var connections: [ObjectIdentifier: NWConnection] = [:]
    let queue = DispatchQueue(label: "bridge-server", qos: .userInteractive)
    let port: UInt16

    init(port: UInt16 = 9876) {
        self.port = port
    }

    func start() throws {
        // Setup audio callback to broadcast to all WebSocket clients
        capture.onAudioBuffer = { [weak self] samples in
            self?.broadcastAudio(samples)
        }

        // Create TCP listener with WebSocket support
        let parameters = NWParameters.tcp
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

        listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)

        listener?.stateUpdateHandler = { state in
            switch state {
            case .ready:
                print("[AudioBridge] Server listening on ws://localhost:\(self.port)")
            case .failed(let error):
                print("[AudioBridge] Server failed: \(error)")
            default:
                break
            }
        }

        listener?.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }

        listener?.start(queue: queue)

        // Also start a simple HTTP server for device enumeration on port+1
        startHTTPServer(port: port + 1)

        print("[AudioBridge] HTTP API available at http://localhost:\(port + 1)")
        print("[AudioBridge] Waiting for connections...")
    }

    private func handleConnection(_ connection: NWConnection) {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                print("[AudioBridge] Client connected")
                self?.connections[ObjectIdentifier(connection)] = connection
                self?.receiveMessages(connection)
            case .failed(let error):
                print("[AudioBridge] Client disconnected: \(error)")
                self?.connections.removeValue(forKey: ObjectIdentifier(connection))
            case .cancelled:
                self?.connections.removeValue(forKey: ObjectIdentifier(connection))
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func receiveMessages(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self = self else { return }

            if let error = error {
                print("[AudioBridge] Receive error: \(error)")
                return
            }

            if let data = data, let message = String(data: data, encoding: .utf8) {
                self.handleClientMessage(message, connection: connection)
            }

            // Continue receiving
            self.receiveMessages(connection)
        }
    }

    private func handleClientMessage(_ message: String, connection: NWConnection) {
        // Parse JSON commands from the browser
        guard let data = message.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let command = json["command"] as? String else {
            print("[AudioBridge] Invalid message: \(message)")
            return
        }

        switch command {
        case "list_devices":
            let devices = capture.listDevices()
            let encoder = JSONEncoder()
            if let jsonData = try? encoder.encode(devices) {
                let response: [String: Any] = ["type": "devices", "devices": (try? JSONSerialization.jsonObject(with: jsonData)) ?? []]
                sendJSON(response, to: connection)
            }

        case "start":
            let deviceID: UInt32
            if let idVal = json["deviceId"] as? NSNumber {
                deviceID = idVal.uint32Value
            } else if let idVal = json["deviceId"] as? Int {
                deviceID = UInt32(idVal)
            } else if let idVal = json["deviceId"] as? UInt32 {
                deviceID = idVal
            } else {
                deviceID = 0
            }
            
            let channel = json["channel"] as? Int ?? 0
            do {
                try capture.start(deviceID: AudioDeviceID(deviceID), channel: channel)
                let response: [String: Any] = [
                    "type": "status",
                    "status": "capturing",
                    "sampleRate": capture.getSampleRate(),
                    "deviceId": deviceID,
                    "channel": channel
                ]
                sendJSON(response, to: connection)
            } catch {
                let response: [String: Any] = ["type": "error", "message": error.localizedDescription]
                sendJSON(response, to: connection)
            }

        case "stop":
            capture.stop()
            sendJSON(["type": "status", "status": "stopped"], to: connection)

        case "switch_channel":
            let channel = json["channel"] as? Int ?? 0
            do {
                try capture.switchChannel(channel)
                sendJSON(["type": "status", "status": "channel_switched", "channel": channel], to: connection)
            } catch {
                sendJSON(["type": "error", "message": error.localizedDescription], to: connection)
            }

        default:
            print("[AudioBridge] Unknown command: \(command)")
        }
    }

    private func sendJSON(_ dict: [String: Any], to connection: NWConnection) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "json", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed({ _ in }))
    }

    private func broadcastAudio(_ samples: [Float]) {
        guard !connections.isEmpty else { return }

        // Convert Float array to raw bytes
        let data = samples.withUnsafeBufferPointer { buffer in
            Data(buffer: UnsafeBufferPointer(
                start: UnsafeRawPointer(buffer.baseAddress!).assumingMemoryBound(to: UInt8.self),
                count: buffer.count * MemoryLayout<Float>.size
            ))
        }

        let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
        let context = NWConnection.ContentContext(identifier: "audio", metadata: [metadata])

        for (_, connection) in connections {
            connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed({ _ in }))
        }
    }

    // Simple HTTP server for device enumeration (no WebSocket upgrade)
    private func startHTTPServer(port: UInt16) {
        let parameters = NWParameters.tcp
        guard let httpListener = try? NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!) else {
            print("[AudioBridge] Failed to start HTTP server")
            return
        }

        httpListener.newConnectionHandler = { [weak self] connection in
            connection.stateUpdateHandler = { state in
                if state == .ready {
                    self?.handleHTTPRequest(connection)
                }
            }
            connection.start(queue: self?.queue ?? .main)
        }

        httpListener.start(queue: queue)
    }

    private func handleHTTPRequest(_ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self = self, let data = data, let request = String(data: data, encoding: .utf8) else { return }

            // Parse the request path
            let lines = request.split(separator: "\r\n")
            guard let requestLine = lines.first else { return }
            let parts = requestLine.split(separator: " ")
            var path = parts.count > 1 ? String(parts[1]) : "/"

            // Default to index.html
            if path == "/" { path = "/index.html" }

            var responseBody: Data
            var contentType = "text/plain"
            var statusCode = 200

            switch path {
            // ── API endpoints ──
            case "/devices":
                contentType = "application/json"
                let devices = self.capture.listDevices()
                let encoder = JSONEncoder()
                encoder.outputFormatting = .prettyPrinted
                responseBody = (try? encoder.encode(devices)) ?? Data("[]".utf8)

            case "/status":
                contentType = "application/json"
                let status: [String: Any] = [
                    "running": self.capture.engine.isRunning,
                    "sampleRate": self.capture.getSampleRate(),
                    "connections": self.connections.count
                ]
                responseBody = (try? JSONSerialization.data(withJSONObject: status)) ?? Data("{}".utf8)

            // ── Static file serving (web root = parent of audio-bridge/) ──
            default:
                // Resolve path relative to the web root (parent of this binary's directory)
                let bridgeDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
                let webRoot = bridgeDir.deletingLastPathComponent()
                
                // Security: prevent directory traversal
                let cleanPath = path.replacingOccurrences(of: "..", with: "")
                let filePath = webRoot.appendingPathComponent(String(cleanPath.dropFirst())).path

                if FileManager.default.fileExists(atPath: filePath) {
                    responseBody = (try? Data(contentsOf: URL(fileURLWithPath: filePath))) ?? Data()

                    // Determine content type from extension
                    let ext = (filePath as NSString).pathExtension.lowercased()
                    switch ext {
                    case "html": contentType = "text/html; charset=utf-8"
                    case "js":   contentType = "application/javascript; charset=utf-8"
                    case "css":  contentType = "text/css; charset=utf-8"
                    case "json": contentType = "application/json"
                    case "png":  contentType = "image/png"
                    case "jpg", "jpeg": contentType = "image/jpeg"
                    case "svg":  contentType = "image/svg+xml"
                    case "woff2": contentType = "font/woff2"
                    case "woff": contentType = "font/woff"
                    case "wav":  contentType = "audio/wav"
                    case "mp3":  contentType = "audio/mpeg"
                    default:     contentType = "application/octet-stream"
                    }
                } else {
                    statusCode = 404
                    contentType = "text/plain"
                    responseBody = Data("404 Not Found: \(path)".utf8)
                }
            }

            let header = """
            HTTP/1.1 \(statusCode) \(statusCode == 200 ? "OK" : "Not Found")\r
            Content-Type: \(contentType)\r
            Content-Length: \(responseBody.count)\r
            Access-Control-Allow-Origin: *\r
            Access-Control-Allow-Headers: *\r
            Connection: close\r
            \r\n
            """

            var fullResponse = Data(header.utf8)
            fullResponse.append(responseBody)

            connection.send(content: fullResponse, completion: .contentProcessed({ _ in
                connection.cancel()
            }))
        }
    }
}

// MARK: - Main Entry Point

let args = CommandLine.arguments
var targetDeviceID: UInt32? = nil
var targetChannel: Int = 0
var serverPort: UInt16 = 9876

// Parse command-line arguments
var i = 1
while i < args.count {
    switch args[i] {
    case "--device":
        i += 1
        if i < args.count { targetDeviceID = UInt32(args[i]) }
    case "--channel":
        i += 1
        if i < args.count { targetChannel = Int(args[i]) ?? 0 }
    case "--port":
        i += 1
        if i < args.count { serverPort = UInt16(args[i]) ?? 9876 }
    case "--help":
        print("""
        AudioBridge — Core Audio to WebSocket bridge

        Usage: AudioBridge [options]

        Options:
          --device <id>    Core Audio device ID to capture from
          --channel <n>    Input channel index (0-based, default: 0)
          --port <port>    WebSocket server port (default: 9876)
          --help           Show this help

        The bridge will:
          1. Start a WebSocket server on ws://localhost:<port>
          2. Start an HTTP API on http://localhost:<port+1>
          3. Wait for commands from the browser to start/stop capture

        HTTP Endpoints:
          GET /devices  — List audio input devices with channel info
          GET /status   — Current capture status
        """)
        exit(0)
    default:
        break
    }
    i += 1
}

// Print available devices
print("\n[AudioBridge] Available audio input devices:")
let devices = getAudioInputDevices()
for device in devices {
    print("  [\(device.id)] \(device.name) — \(device.inputChannels) channels @ \(device.sampleRate)Hz")
}
print()

// Start the server
let server = BridgeServer(port: serverPort)
do {
    try server.start()
} catch {
    print("[AudioBridge] Failed to start: \(error)")
    exit(1)
}

// Keep the process running
dispatchMain()
