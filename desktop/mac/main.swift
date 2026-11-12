// Spotify Quiet for macOS: the launcher app.
//
// Opening this app opens Spotify with a local DevTools port and loads quiet.js
// (bundled in the app) into Spotify's own window. Nothing inside Spotify.app is
// changed: quit Spotify and open it the normal way and it is stock again.
//
// The app has no window. It stays running in the background while Spotify is
// open and quits when Spotify does. Its log is ~/Library/Logs/spotify-quiet.log.
//
//   "Spotify Quiet.app/Contents/MacOS/Spotify Quiet" --report
// prints what the script did inside Spotify.

import AppKit
import Foundation

let port = Int(ProcessInfo.processInfo.environment["SPOTIFY_QUIET_PORT"] ?? "") ?? 19888
let base = "http://127.0.0.1:\(port)"
let spotifyBundleID = "com.spotify.client"
let uiPrefix = "https://xpui.app.spotify.com/"
let reportMode = CommandLine.arguments.contains("--report")

struct LauncherError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

// Requests to this computer only, never through a system proxy.
let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.connectionProxyDictionary = [:]
    configuration.timeoutIntervalForRequest = 3
    return URLSession(configuration: configuration)
}()

// ---------------------------------------------------------------- logging

let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/spotify-quiet.log")

func log(_ message: String) {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    let line = "\(formatter.string(from: Date()))  \(message)\n"
    FileHandle.standardOutput.write(Data(line.utf8))
    if reportMode { return }
    if let handle = try? FileHandle(forWritingTo: logURL) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    } else {
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data(line.utf8).write(to: logURL)
    }
}

func pause(_ seconds: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
}

// ---------------------------------------------------------- the Spotify app

enum PortState { case spotify, other, closed }

func getJSON(_ route: String) async throws -> Any {
    let (data, _) = try await session.data(from: URL(string: base + route)!)
    return try JSONSerialization.jsonObject(with: data)
}

// Is something answering on the port, and is it Spotify?
func portState() async -> PortState {
    guard let version = try? await getJSON("/json/version") as? [String: Any] else { return .closed }
    let agent = version["User-Agent"] as? String ?? ""
    return agent.contains("Spotify/") ? .spotify : .other
}

func spotifyInstances() -> [NSRunningApplication] {
    NSRunningApplication.runningApplications(withBundleIdentifier: spotifyBundleID)
}

func openSpotify() async throws {
    switch await portState() {
    case .spotify:
        log("Spotify is already open with the port. Attaching.")
        return
    case .other:
        throw LauncherError("Port \(port) is in use by another program.")
    case .closed:
        break
    }
    guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: spotifyBundleID) else {
        throw LauncherError("Spotify is not installed on this Mac.")
    }
    if !spotifyInstances().isEmpty {
        log("Spotify is open without the port. Closing it to reopen it.")
        for instance in spotifyInstances() { instance.terminate() }
        for _ in 0..<40 where !spotifyInstances().isEmpty { await pause(0.25) }
        if !spotifyInstances().isEmpty {
            throw LauncherError("Spotify did not close. Quit it and open Spotify Quiet again.")
        }
    }
    log("Opening Spotify.")
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.arguments = ["--remote-debugging-port=\(port)"]
    _ = try await NSWorkspace.shared.openApplication(at: appURL, configuration: configuration)
    for _ in 0..<120 {
        if await portState() == .spotify { return }
        await pause(0.25)
    }
    throw LauncherError("Spotify opened but its port did not answer. This version of Spotify may no longer allow it.")
}

// ---------------------------------------------------------------- DevTools

// One connection to a Spotify window. While it stays open, the script that was
// registered on it is loaded again each time the window reloads. Its state is
// guarded by a lock, so it is safe to use from any thread.
final class Page: @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let lock = NSLock()
    private var nextID = 0
    private var waiters: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var isClosed = false

    var closed: Bool {
        lock.lock(); defer { lock.unlock() }
        return isClosed
    }

    init(socket: URL) {
        task = session.webSocketTask(with: socket)
        task.maximumMessageSize = 16 * 1024 * 1024
        task.resume()
        receive()
    }

    private func receive() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.finish(with: error)
            case .success(let message):
                if case .string(let text) = message,
                   let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                   let id = object["id"] as? Int {
                    self.lock.lock()
                    let waiter = self.waiters.removeValue(forKey: id)
                    self.lock.unlock()
                    if let problem = object["error"] as? [String: Any] {
                        waiter?.resume(throwing: LauncherError(problem["message"] as? String ?? "DevTools error"))
                    } else {
                        waiter?.resume(returning: object["result"] as? [String: Any] ?? [:])
                    }
                }
                self.receive()
            }
        }
    }

    private func finish(with error: Error) {
        lock.lock()
        isClosed = true
        let pending = waiters
        waiters.removeAll()
        lock.unlock()
        for waiter in pending.values { waiter.resume(throwing: error) }
    }

    private func fail(_ id: Int, _ error: Error) {
        lock.lock()
        let waiter = waiters.removeValue(forKey: id)
        lock.unlock()
        waiter?.resume(throwing: error)
    }

    private func newID() -> Int {
        lock.lock(); defer { lock.unlock() }
        nextID += 1
        return nextID
    }

    func send(_ method: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
        let id = newID()
        let payload = try JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params])
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if isClosed {
                lock.unlock()
                continuation.resume(throwing: LauncherError("the window closed"))
                return
            }
            waiters[id] = continuation
            lock.unlock()
            task.send(.string(String(decoding: payload, as: UTF8.self))) { [weak self] error in
                if let error { self?.fail(id, error) }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 20) { [weak self] in
                self?.fail(id, LauncherError("\(method) timed out"))
            }
        }
    }

    func evaluate(_ expression: String) async throws -> Any? {
        let result = try await send("Runtime.evaluate", ["expression": expression, "awaitPromise": true, "returnByValue": true])
        if let details = result["exceptionDetails"] as? [String: Any] {
            let exception = details["exception"] as? [String: Any]
            throw LauncherError(exception?["description"] as? String ?? details["text"] as? String ?? "script error")
        }
        return (result["result"] as? [String: Any])?["value"]
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

struct Target {
    let id: String
    let socket: URL
}

// Spotify's main window, as DevTools lists it.
func uiTargets() async throws -> [Target] {
    guard let list = try await getJSON("/json/list") as? [[String: Any]] else { return [] }
    return list.compactMap { entry in
        guard entry["type"] as? String == "page",
              let url = entry["url"] as? String, url.hasPrefix(uiPrefix),
              let id = entry["id"] as? String,
              let address = entry["webSocketDebuggerUrl"] as? String,
              let socket = URL(string: address) else { return nil }
        return Target(id: id, socket: socket)
    }
}

func loadScript() throws -> String {
    let beside = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("quiet.js")
    guard let url = Bundle.main.url(forResource: "quiet", withExtension: "js") ?? (FileManager.default.fileExists(atPath: beside.path) ? beside : nil) else {
        throw LauncherError("quiet.js is missing from the app.")
    }
    return try String(contentsOf: url, encoding: .utf8)
}

// ------------------------------------------------------------------- modes

func report() async throws {
    guard await portState() == .spotify else {
        throw LauncherError("Spotify is not open with the port. Open Spotify Quiet first.")
    }
    guard let target = try await uiTargets().first else {
        throw LauncherError("Spotify is open but its main window is not ready.")
    }
    let page = Page(socket: target.socket)
    let text = try await page.evaluate("window.__spQuiet ? window.__spQuiet.report() : JSON.stringify({ spotifyQuietReport: 1, where: 'desktop', loaded: false })")
    page.close()
    print(text as? String ?? "{}")
}

func keepQuiet() async throws {
    let script = try loadScript()
    try await openSpotify()
    var pages: [String: Page] = [:]
    var misses = 0
    var announced = false
    while true {
        // Finished as soon as Spotify is gone.
        if spotifyInstances().isEmpty { break }
        if let targets = try? await uiTargets() {
            misses = 0
            pages = pages.filter { !$0.value.closed }
            for target in targets where pages[target.id] == nil {
                do {
                    let page = Page(socket: target.socket)
                    _ = try await page.send("Page.enable")
                    _ = try await page.send("Page.addScriptToEvaluateOnNewDocument", ["source": script])
                    _ = try await page.evaluate(script)
                    pages[target.id] = page
                    log("Loaded into the Spotify window.")
                } catch {
                    log("Could not load into the window yet (\(error)). Trying again.")
                }
            }
            if !announced, let page = pages.values.first {
                announced = true
                // Give the script a moment to find the app's ad services, then say how it went.
                Task {
                    await pause(4)
                    guard let text = try? await page.evaluate("window.__spQuiet.report()") as? String,
                          let state = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return }
                    if state["ready"] as? Bool == true {
                        log("Ads off: \(state["slotsSeen"] as? Int ?? 0) ad slots switched off.")
                    } else {
                        log("The app has not exposed its ad services yet. Still trying.")
                    }
                }
            }
        } else {
            // The port did not answer although Spotify is running: allow a few misses.
            misses += 1
            if misses >= 5 { break }
        }
        await pause(1.5)
    }
    log("Spotify closed. Done.")
}

@MainActor
func showProblem(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Spotify Quiet"
    alert.informativeText = message
    alert.alertStyle = .warning
    NSApplication.shared.activate(ignoringOtherApps: true)
    alert.runModal()
}

// ------------------------------------------------------------------- start

let application = NSApplication.shared
application.setActivationPolicy(.accessory)

Task {
    do {
        if reportMode { try await report() } else { try await keepQuiet() }
        exit(0)
    } catch {
        let message = (error as? LauncherError)?.description ?? error.localizedDescription
        if reportMode {
            FileHandle.standardError.write(Data("Spotify Quiet: \(message)\n".utf8))
        } else {
            log("Spotify Quiet: \(message)")
            // Opened from Finder there is no terminal to read, so say it in a dialog.
            if isatty(STDOUT_FILENO) == 0 { await showProblem(message) }
        }
        exit(1)
    }
}

application.run()
