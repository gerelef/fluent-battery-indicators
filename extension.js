// SPDX-License-Identifier: GPL-2.0-or-later
//
// Fluent Battery Indicators — GNOME Shell Extension  (target: GNOME 49)
//
// Adds one flat, full-width row per connected peripheral battery device
// directly in the Quick Settings panel, positioned just before the
// Background Apps section.  No expandable sub-menu, no toggle pill.
//
// Row layout  (left → right):
//   [device-type icon]  [device name ──────────────]  [XX %]  [battery icon]
//
// ── Why D-Bus proxies, not UPower.Client ──────────────────────────────────
// new UPower.Client() inside gnome-shell's compositor causes a SIGSEGV.
// Every UPower indicator in the shell itself (system.js, endSessionDialog…)
// uses Gio.DBusProxy.makeProxyWrapper() exclusively, so do we.
//
// ── Architecture ──────────────────────────────────────────────────────────
//  FluentBatteryIndicators   (Extension)
//    └─ BatteryIndicator     (SystemIndicator — owns D-Bus proxies + rows)
//         ├─ _warningIcon    (St.Icon in the panel bar, shown when any low)
//         └─ DeviceBatteryRow × N  (St.BoxLayout — flat row in the grid)

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import Pango from "gi://Pango";
import St from "gi://St";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { SystemIndicator } from "resource:///org/gnome/shell/ui/quickSettings.js";

// ─────────────────────────────────────────────────────────────────────────────
// UPower D-Bus interface definitions
// ─────────────────────────────────────────────────────────────────────────────

const UPOWER_BUS = "org.freedesktop.UPower";
const UPOWER_PATH = "/org/freedesktop/UPower";

const UPOWER_MANAGER_IFACE = `
<node>
  <interface name="org.freedesktop.UPower">
    <method name="EnumerateDevices">
      <arg name="devices" type="ao" direction="out"/>
    </method>
    <signal name="DeviceAdded">   <arg name="device" type="o"/></signal>
    <signal name="DeviceRemoved"> <arg name="device" type="o"/></signal>
  </interface>
</node>`;

// Extended interface — adds Vendor / Model on top of gnome-shell's minimal
// data/dbus-interfaces/org.freedesktop.UPower.Device.xml
const UPOWER_DEVICE_IFACE = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="NativePath"             type="s" access="read"/>
    <property name="Vendor"                 type="s" access="read"/>
    <property name="Model"                  type="s" access="read"/>
    <property name="Type"                   type="u" access="read"/>
    <property name="PowerSupply"            type="b" access="read"/>
    <property name="IsPresent"              type="b" access="read"/>
    <property name="State"                  type="u" access="read"/>
    <property name="Percentage"             type="d" access="read"/>
    <property name="TimeToEmpty"            type="x" access="read"/>
    <property name="TimeToFull"             type="x" access="read"/>
    <property name="IconName"               type="s" access="read"/>
    <property name="ChargeThresholdEnabled" type="b" access="read"/>
    <property name="WarningLevel"           type="u" access="read"/>
  </interface>
</node>`;

const UPowerManagerProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_MANAGER_IFACE);
const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_DEVICE_IFACE);

// ─────────────────────────────────────────────────────────────────────────────
// Integer shims for UPower enums  (values from libupower-glib's up-enums.h)
//
// Defined locally so we never import gi://UPowerGlib — its GObject constructor
// crashes the Wayland compositor with a SIGSEGV.
// ─────────────────────────────────────────────────────────────────────────────

// UpDeviceKind
const DeviceKind = Object.freeze({
    UNKNOWN: 0,
    LINE_POWER: 1,
    BATTERY: 2, // host battery — already in the system indicator
    UPS: 3,
    MONITOR: 4,
    MOUSE: 5,
    KEYBOARD: 6,
    PDA: 7,
    PHONE: 8,
    MEDIA_PLAYER: 9,
    TABLET: 10,
    COMPUTER: 11,
    GAMING_INPUT: 12,
    PEN: 13,
    TOUCHPAD: 14,
    MODEM: 15,
    NETWORK: 16,
    HEADSET: 17,
    SPEAKERS: 18,
    HEADPHONES: 19,
    VIDEO: 20,
    OTHER_AUDIO: 21,
    REMOTE_CONTROL: 22,
    PRINTER: 23,
    SCANNER: 24,
    CAMERA: 25,
    WEARABLE: 26,
    TOY: 27,
    BLUETOOTH_GENERIC: 28,
});

// UpDeviceState
const DeviceState = Object.freeze({
    UNKNOWN: 0,
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6,
});

// ─────────────────────────────────────────────────────────────────────────────
// Which device kinds to display
// ─────────────────────────────────────────────────────────────────────────────
//
// Excluded:
//   LINE_POWER (1) — not a battery
//   BATTERY    (2) — the host laptop battery; already shown by the shell's
//                    built-in system indicator via the DisplayDevice composite
//   MODEM / NETWORK / VIDEO / WEARABLE / TOY — mirrors the intentional
//   omission in gsd-power-manager.c ("too uncommon, name too imprecise")

const PERIPHERAL_KINDS = new Set([
    DeviceKind.UPS,
    DeviceKind.MONITOR,
    DeviceKind.MOUSE,
    DeviceKind.KEYBOARD,
    DeviceKind.PDA,
    DeviceKind.PHONE,
    DeviceKind.MEDIA_PLAYER,
    DeviceKind.TABLET,
    DeviceKind.COMPUTER,
    DeviceKind.GAMING_INPUT,
    DeviceKind.PEN,
    DeviceKind.TOUCHPAD,
    DeviceKind.HEADSET,
    DeviceKind.SPEAKERS,
    DeviceKind.HEADPHONES,
    DeviceKind.OTHER_AUDIO,
    DeviceKind.REMOTE_CONTROL,
    DeviceKind.PRINTER,
    DeviceKind.SCANNER,
    DeviceKind.CAMERA,
    DeviceKind.BLUETOOTH_GENERIC,
]);

/** Battery charge (percent) below which a caution icon appears in the panel bar. */
const LOW_BATTERY_THRESHOLD = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind fallback display metadata
// ─────────────────────────────────────────────────────────────────────────────

const KIND_NAMES = {
    [DeviceKind.UPS]: "UPS",
    [DeviceKind.MONITOR]: "Monitor",
    [DeviceKind.MOUSE]: "Mouse",
    [DeviceKind.KEYBOARD]: "Keyboard",
    [DeviceKind.PDA]: "PDA",
    [DeviceKind.PHONE]: "Phone",
    [DeviceKind.MEDIA_PLAYER]: "Media Player",
    [DeviceKind.TABLET]: "Tablet",
    [DeviceKind.COMPUTER]: "Computer",
    [DeviceKind.GAMING_INPUT]: "Game Controller",
    [DeviceKind.PEN]: "Pen",
    [DeviceKind.TOUCHPAD]: "Touchpad",
    [DeviceKind.HEADSET]: "Headset",
    [DeviceKind.SPEAKERS]: "Speakers",
    [DeviceKind.HEADPHONES]: "Headphones",
    [DeviceKind.OTHER_AUDIO]: "Audio Device",
    [DeviceKind.REMOTE_CONTROL]: "Remote Control",
    [DeviceKind.PRINTER]: "Printer",
    [DeviceKind.SCANNER]: "Scanner",
    [DeviceKind.CAMERA]: "Camera",
    [DeviceKind.BLUETOOTH_GENERIC]: "Bluetooth Device",
};

// Symbolic icon representing the type of device (not its battery level)
const KIND_ICONS = {
    [DeviceKind.UPS]: "uninterruptible-power-supply-symbolic",
    [DeviceKind.MONITOR]: "video-display-symbolic",
    [DeviceKind.MOUSE]: "input-mouse-symbolic",
    [DeviceKind.KEYBOARD]: "input-keyboard-symbolic",
    [DeviceKind.PDA]: "pda-symbolic",
    [DeviceKind.PHONE]: "phone-symbolic",
    [DeviceKind.MEDIA_PLAYER]: "multimedia-player-symbolic",
    [DeviceKind.TABLET]: "input-tablet-symbolic",
    [DeviceKind.COMPUTER]: "computer-symbolic",
    [DeviceKind.GAMING_INPUT]: "input-gaming-symbolic",
    [DeviceKind.PEN]: "input-tablet-symbolic",
    [DeviceKind.TOUCHPAD]: "input-touchpad-symbolic",
    [DeviceKind.HEADSET]: "audio-headset-symbolic",
    [DeviceKind.SPEAKERS]: "audio-speakers-symbolic",
    [DeviceKind.HEADPHONES]: "audio-headphones-symbolic",
    [DeviceKind.OTHER_AUDIO]: "audio-card-symbolic",
    [DeviceKind.REMOTE_CONTROL]: "input-gaming-symbolic",
    [DeviceKind.PRINTER]: "printer-symbolic",
    [DeviceKind.SCANNER]: "scanner-symbolic",
    [DeviceKind.CAMERA]: "camera-photo-symbolic",
    [DeviceKind.BLUETOOTH_GENERIC]: "bluetooth-active-symbolic",
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure helper functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DBus int64 ("x") properties come back as BigInt in GJS ≥ 1.76 (GNOME 44+).
 * Normalise to a plain Number (seconds).
 *
 * @param {bigint|number|null|undefined} v
 * @returns {number}
 */
function _toSeconds(v) {
    if (typeof v === "bigint") return Number(v);
    return typeof v === "number" && isFinite(v) ? v : 0;
}

/**
 * Battery-level icon name, computed from State and Percentage.
 * Mirrors the logic in gnome-shell's system.js PowerToggle._sync() so the
 * icons are consistent with the rest of the shell.
 *
 * Examples:
 *   battery-level-80-symbolic
 *   battery-level-40-charging-symbolic
 *   battery-level-100-charged-symbolic
 *
 * @param {Gio.DBusProxy} proxy
 * @returns {string}
 */
function _batteryIconName(proxy) {
    const state = proxy.State ?? DeviceState.UNKNOWN;
    const percentage = proxy.Percentage ?? 0;

    let chargingState = "";
    if (state === DeviceState.CHARGING) chargingState = "-charging";
    else if (state === DeviceState.PENDING_CHARGE && proxy.ChargeThresholdEnabled) chargingState = "-plugged-in";

    const fillLevel = 10 * Math.floor(percentage / 10);
    const isCharged = state === DeviceState.FULLY_CHARGED || (state === DeviceState.CHARGING && fillLevel === 100);

    return isCharged ? "battery-level-100-charged-symbolic" : `battery-level-${fillLevel}${chargingState}-symbolic`;
}

/**
 * Device-type icon: the symbolic icon that represents what kind of device
 * this is (mouse, keyboard, game controller, …), NOT its battery level.
 * Falls back to a generic battery symbol when the kind is unrecognised.
 *
 * @param {Gio.DBusProxy} proxy
 * @returns {string}
 */
function _deviceTypeIcon(proxy) {
    return KIND_ICONS[proxy.Type] ?? "battery-symbolic";
}

/**
 * Human-readable device name from Vendor + Model strings.
 * Deduplicates when one is a prefix of the other
 * (e.g. avoids "Apple Apple Magic Keyboard").
 *
 * @param {Gio.DBusProxy} proxy
 * @returns {string}
 */
function _deviceName(proxy) {
    const vendor = proxy.Vendor?.trim() ?? "";
    const model = proxy.Model?.trim() ?? "";

    if (vendor && model) {
        if (model.toLowerCase().startsWith(vendor.toLowerCase())) return model;
        return `${vendor} ${model}`;
    }
    if (model) return model;
    if (vendor) return vendor;
    return KIND_NAMES[proxy.Type] ?? "Unknown Device";
}

/**
 * Return true if this device proxy represents a peripheral we should show.
 *
 * @param {Gio.DBusProxy} proxy
 * @returns {boolean}
 */
function _isPeripheral(proxy) {
    return PERIPHERAL_KINDS.has(proxy.Type) && !!proxy.IsPresent;
}

// ─────────────────────────────────────────────────────────────────────────────
// DeviceBatteryRow
//
// A single flat, non-interactive full-width row in the Quick Settings grid.
//
//   [device-type icon]  [device name ──────────]  [XX %]  [battery-level icon]
//    left-justified      left-justified, expands   right    right, last
// ─────────────────────────────────────────────────────────────────────────────

const DeviceBatteryRow = GObject.registerClass(
    class DeviceBatteryRow extends St.BoxLayout {
        /**
         * @param {string}        objectPath  UPower D-Bus object path (stable key)
         * @param {Gio.DBusProxy} proxy       Fully-initialised UPowerDeviceProxy
         */
        constructor(objectPath, proxy) {
            super({
                style_class: "battery-device-row",
                x_expand: true,
                y_expand: false,
                reactive: false,
            });

            this._objectPath = objectPath;
            this._proxy = proxy;

            // ── 1. Device-type icon — left-justified ─────────────────────────
            this._deviceIcon = new St.Icon({
                style_class: "battery-device-type-icon",
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._deviceIcon);

            // ── 2. Device name — left-justified, expands ─────────────────────
            this._nameLabel = new St.Label({
                style_class: "battery-device-name",
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this.add_child(this._nameLabel);

            // ── 3. Battery percentage — right-justified ──────────────────────
            this._percentLabel = new St.Label({
                style_class: "battery-device-percentage",
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._percentLabel);

            // ── 4. Battery-level icon — right-justified, last ────────────────
            this._batteryIcon = new St.Icon({
                style_class: "battery-device-battery-icon",
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._batteryIcon);

            // Re-sync on any property change on the remote device object.
            //
            // connectObject() is patched onto GObject.Object.prototype by
            // gnome-shell's environment.js.  It is auto-disconnected when *this*
            // is destroyed because Clutter.Actor is a registered destroyable type
            // in signalTracker.js.
            this._proxy.connectObject("g-properties-changed", () => this._sync(), this);

            this._sync();
        }

        /** UPower D-Bus object path — stable identifier for this device. */
        get objectPath() {
            return this._objectPath;
        }

        /** The underlying D-Bus device proxy. */
        get proxy() {
            return this._proxy;
        }

        // ── Private ─────────────────────────────────────────────────────────────

        _sync() {
            // Collapse the row if the physical device is no longer present
            // (e.g. a device that temporarily disappears).  The row stays in the
            // grid and reappears automatically when IsPresent becomes true again.
            // Full removal happens via DeviceRemoved → _removeDevice().
            if (!this._proxy.IsPresent) {
                this.visible = false;
                return;
            }
            this.visible = true;

            // 1. Device-type icon
            this._deviceIcon.icon_name = _deviceTypeIcon(this._proxy);

            // 2. Name
            this._nameLabel.text = _deviceName(this._proxy);

            // 3. Percentage  (narrow no-break space before the % sign)
            const pct = Math.round(this._proxy.Percentage ?? 0);
            this._percentLabel.text = `${pct}\u202f%`;

            // Apply warning colour when discharging below the threshold
            const isLow = pct <= LOW_BATTERY_THRESHOLD && this._proxy.State === DeviceState.DISCHARGING;
            if (isLow) this._percentLabel.add_style_class_name("battery-device-percentage-low");
            else this._percentLabel.remove_style_class_name("battery-device-percentage-low");

            // 4. Battery-level icon.
            // ThemedIcon lets GTK walk the named-icon fallback chain rather than
            // hard-failing when a specific battery-level symbol is missing.
            this._batteryIcon.gicon = new Gio.ThemedIcon({
                name: _batteryIconName(this._proxy),
                use_default_fallbacks: false,
            });
            this._batteryIcon.fallback_icon_name = "battery-symbolic";
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// BatteryIndicator  (SystemIndicator)
//
// Owns the D-Bus proxies and the DeviceBatteryRow map.  Each row is inserted
// directly into the Quick Settings panel grid — no intermediate expandable
// container.
//
// quickSettingsItems is intentionally left empty.  addExternalIndicator() is
// called only to place the panel-bar _warningIcon; all grid rows are managed
// dynamically by _insertRow() / _removeDevice().
// ─────────────────────────────────────────────────────────────────────────────

const BatteryIndicator = GObject.registerClass(
    class BatteryIndicator extends SystemIndicator {
        _init() {
            super._init();

            // ── Panel-bar caution icon ───────────────────────────────────────
            // Becomes visible when any tracked peripheral is discharging below
            // LOW_BATTERY_THRESHOLD.  Hidden by default; SystemIndicator hides
            // itself from the panel bar when all its children are invisible.
            this._warningIcon = this._addIndicator();
            this._warningIcon.icon_name = "battery-caution-symbolic";
            this._warningIcon.visible = false;

            // ── Device row map ───────────────────────────────────────────────
            /** @type {Map<string, DeviceBatteryRow>}  objectPath → row */
            this._rows = new Map();

            // ── Async-safety guard ───────────────────────────────────────────
            // Set in destroy(); any in-flight D-Bus callbacks check this flag
            // and discard their results silently rather than touching dead objects.
            this._cancelled = false;

            // ── D-Bus handles ────────────────────────────────────────────────
            this._managerProxy = null;
            this._deviceAddedId = 0;
            this._deviceRemovedId = 0;

            this._setupUPower();
        }

        // ── D-Bus initialisation ─────────────────────────────────────────────────

        _setupUPower() {
            // Always create proxies asynchronously.  Even a "fast" synchronous
            // D-Bus call can stall the Wayland compositor long enough to trigger
            // the watchdog and cause a SIGSEGV.
            new UPowerManagerProxy(Gio.DBus.system, UPOWER_BUS, UPOWER_PATH, (proxy, error) => {
                if (this._cancelled) return;
                if (error) {
                    console.error(`[fluent-battery-indicators] UPower manager proxy failed: ${error.message}`);
                    return;
                }

                this._managerProxy = proxy;

                // Hot-plug — new device connected while the shell is running
                this._deviceAddedId = proxy.connectSignal("DeviceAdded", (_p, _sender, [objectPath]) => {
                    if (!this._cancelled) this._addDevice(objectPath);
                });

                // Hot-unplug
                this._deviceRemovedId = proxy.connectSignal("DeviceRemoved", (_p, _sender, [objectPath]) => {
                    if (!this._cancelled) this._removeDevice(objectPath);
                });

                // Cold-plug — enumerate devices already present
                this._coldPlug();
            });
        }

        _coldPlug() {
            this._managerProxy.EnumerateDevicesRemote((result, error) => {
                if (this._cancelled) return;
                if (error) {
                    console.error(`[fluent-battery-indicators] EnumerateDevices failed: ${error.message}`);
                    return;
                }

                // makeProxyWrapper unwraps the (ao) return tuple; result[0] is
                // the JavaScript array of object-path strings.
                const paths = Array.isArray(result?.[0]) ? result[0] : [];
                for (const path of paths) {
                    if (typeof path === "string") this._addDevice(path);
                }
            });
        }

        /**
         * Asynchronously create a device proxy for *objectPath*, then check if
         * it is a peripheral and — if so — create and insert its row.
         *
         * @param {string} objectPath
         */
        _addDevice(objectPath) {
            if (this._rows.has(objectPath)) return; // already tracked

            new UPowerDeviceProxy(Gio.DBus.system, UPOWER_BUS, objectPath, (proxy, error) => {
                // Guard: disable() may have been called while this proxy was
                // being initialised asynchronously.
                if (this._cancelled) return;
                if (error) {
                    console.warn(`[fluent-battery-indicators] device proxy ${objectPath}: ${error.message}`);
                    return;
                }
                // Another guard: a DeviceRemoved could have arrived between
                // the proxy-construction call and this callback.
                if (this._rows.has(objectPath)) return;

                if (_isPeripheral(proxy)) this._insertRow(objectPath, proxy);
            });
        }

        /**
         * Create a DeviceBatteryRow and add it to the Quick Settings panel grid
         * immediately before the Background Apps section.
         *
         * @param {string}        objectPath
         * @param {Gio.DBusProxy} proxy
         */
        _insertRow(objectPath, proxy) {
            const row = new DeviceBatteryRow(objectPath, proxy);
            this._rows.set(objectPath, row);

            // The Quick Settings panel grid expects items with a column-span
            // metadata property set by QuickSettingsLayout.  colSpan = 2 makes
            // the row span the full width of the two-column grid.
            //
            // We use the same sibling anchor that addExternalIndicator() uses:
            // the last item of the Background Apps indicator's quickSettingsItems.
            // Inserting *before* that anchor places our rows just above Background
            // Apps, which is exactly the position the user requested.
            const qs = Main.panel.statusArea.quickSettings;
            const sibling = qs._backgroundApps?.quickSettingsItems?.at(-1) ?? null;
            qs.menu.insertItemBefore(row, sibling, 2);

            // Also track property changes here in BatteryIndicator so that the
            // panel-bar warning icon can be updated whenever any device's charge
            // level or state changes.  (DeviceBatteryRow has its own independent
            // listener for its own visual update.)
            proxy.connectObject("g-properties-changed", () => this._syncWarningIcon(), this);

            this._syncWarningIcon();
        }

        /**
         * Destroy the row for *objectPath* and remove it from the grid.
         *
         * @param {string} objectPath
         */
        _removeDevice(objectPath) {
            const row = this._rows.get(objectPath);
            if (!row) return;

            // Disconnect the warning-icon listener before row.destroy() so we
            // never receive a stale callback from a destroyed proxy.
            row.proxy.disconnectObject(this);

            // Destroying the Clutter actor removes it from the panel grid and
            // fires 'destroy', which auto-disconnects all connectObject() signals
            // that used *row* as the tracked object (i.e. the proxy listener
            // inside DeviceBatteryRow._init).
            row.destroy();
            this._rows.delete(objectPath);

            this._syncWarningIcon();
        }

        /** Show the panel-bar caution icon when any device is critically low. */
        _syncWarningIcon() {
            const anyLow = [...this._rows.values()].some(
                (row) =>
                    row.visible &&
                    (row.proxy.Percentage ?? 100) <= LOW_BATTERY_THRESHOLD &&
                    row.proxy.State === DeviceState.DISCHARGING,
            );
            this._warningIcon.visible = anyLow;
        }

        // ── Lifecycle ────────────────────────────────────────────────────────────

        destroy() {
            this._cancelled = true;

            // Destroy all device rows — this removes them from the panel grid
            // and auto-disconnects their internal proxy listeners.
            for (const row of this._rows.values()) {
                row.proxy.disconnectObject(this); // our warning-icon listener
                row.destroy(); // row's own listeners + actor
            }
            this._rows.clear();

            // Disconnect D-Bus signals.  connectSignal() IDs are NOT tracked by
            // gnome-shell's GObject signal-tracker, so we must clean them up here.
            if (this._managerProxy) {
                if (this._deviceAddedId) this._managerProxy.disconnectSignal(this._deviceAddedId);
                if (this._deviceRemovedId) this._managerProxy.disconnectSignal(this._deviceRemovedId);
                this._deviceAddedId = 0;
                this._deviceRemovedId = 0;
                this._managerProxy = null;
            }

            super.destroy();
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────

export default class FluentBatteryIndicators extends Extension {
    enable() {
        this._indicator = new BatteryIndicator();

        // addExternalIndicator() serves two purposes:
        //   1. Inserts the BatteryIndicator actor (containing _warningIcon)
        //      into the panel-bar indicators box.
        //   2. Would insert indicator.quickSettingsItems into the grid —
        //      but quickSettingsItems is intentionally empty here, because
        //      the device rows are managed dynamically by _insertRow() as
        //      devices are discovered asynchronously over D-Bus.
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        // BatteryIndicator.destroy() cleans up:
        //   • all DeviceBatteryRow actors (removed from the panel grid)
        //   • D-Bus signal connections on the manager proxy
        //   • the panel-bar indicator actor itself
        this._indicator?.destroy();
        this._indicator = null;
    }
}
