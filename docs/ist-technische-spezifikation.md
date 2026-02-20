# IST-Funktion – umsetzbare technische Spezifikation

## 1. Zielbild und Scope

Die IST-Funktion ergänzt die bestehende Planung um einen operativen Korrektur-Workflow:

1. Pro Abfülllinie werden die aktuellen Aufträge in **Pos.1–Pos.3** bearbeitet.
2. Änderungen (Restmenge, Löschen) recalculieren den Linien-Zeitstrahl mit **06:00 als Jetzt-Anker**.
3. Nach jeder Änderung erfolgt eine **Konfliktprüfung gegen Rührwerk-Zeitstrahl**.
4. Übernahme in den Hauptplaner erfolgt ausschließlich explizit über **„Planer aktualisieren“**.

Nicht im Scope:
- Automatische Reihenfolgeoptimierung.
- Automatische Übernahme in den Hauptplaner.
- Automatisches Löschen/Umbuchen ohne Nutzeraktion.

---

## 2. Fachliche Regeln (verbindlich in Logik und UI)

| Regel | Technische Auswirkung |
|---|---|
| 1) Restmenge immer editierbar (alle Status) | Input-Feld nie read-only aufgrund Status; nur numerische Validierung. |
| 2) Locked bleibt bei Restmengenänderung erhalten | `locked`-Flag bei Update nicht überschreiben. |
| 3) Restmenge < Startmenge verkleinert Zeitblock proportional | Neue Dauer = `ceil(originalDuration * rest/start)` (min. 1 min, sofern rest > 0). |
| 4) Betroffener Auftrag auf 06:00 setzen | `startAt = 06:00`; `endAt = 06:00 + neue Dauer`. |
| 5) Folgeaufträge rücken zeitlich nach | Aufträge Pos2..n behalten Reihenfolge, werden an neues Ende des Vorgängers angeschlossen. |
| 6) Restmenge = 0 wie Löschen | Gleiche Codepfad-Logik wie explizite Löschaktion. |
| 7) Löschen im IST mit Nachrücken | Entferne Auftrag aus Linie; Positionen neu indizieren (Pos2→Pos1...). |
| 8) Keine automatische Löschung/Umplanung | Nur durch konkrete User-Events (`saveRest`, `deleteOrder`, `updatePlanner`). |
| 9) Nach jeder IST-Änderung Konfliktprüfung | Realtime-Check auf Rührwerksüberschneidungen nach jeder Mutation. |
| 10) Bei Überschneidung Warnung + Sperre | CTA „Planer aktualisieren“ deaktivieren, klarer Warnhinweis. |
| 11) Ohne Überschneidung CTA erlaubt | Button aktiv, sofern Dirty-State vorhanden. |
| 12) Hauptplaner nur per Button | Zwei-Phasen-Modell: IST-Session-State ≠ persisted Hauptplaner. |
| 13) Undo + Lösch-Bestätigung | Session-History (stack) und Confirm-Dialog vor Delete. |

---

## 3. UX / UI-Flow

## 3.1 Navigation
- Neuer Hauptmenüpunkt **„IST“** zwischen **„Planung“** und **„Stammdaten“**.
- Route-Vorschlag: `/ist`.

## 3.2 Seitenlayout IST
- Linke Seite: Linienauswahl (Tabs oder Accordion für L1..Ln).
- Hauptbereich pro Linie:
  - Tabelle/Karten für **Pos.1, Pos.2, Pos.3** (optional mehr Positionen intern, aber Fokus auf Top-3).
  - Pro Position: Auftrag, Status, Startmenge, Restmenge (editierbar), Dauer, Start/Ende, Locked-Indikator.
  - Aktionen: **Speichern** (Restmenge), **Löschen** (mit Dialog).
- Globaler Footer/Header:
  - Konfliktstatus-Badge (grün/rot)
  - **Undo**
  - **Planer aktualisieren** (enabled/disabled)

## 3.3 Interaktionsfluss Restmenge ändern
1. User ändert Restmenge in Pos.X.
2. Client-Validierung (Pflicht, Zahl, >=0).
3. Aktion „Speichern“:
   - Server berechnet neue Zeitachse (06:00-Anker + Folgeaufträge nachrücken).
   - Server prüft Rührwerkskonflikte.
4. UI aktualisiert Timeline-Snapshot.
5. Bei Konflikt:
   - Warnbanner: „Rührwerksüberschneidung erkannt. Bitte Konflikt lösen, bevor der Hauptplaner aktualisiert werden kann.“
   - Button „Planer aktualisieren“ disabled.
6. Ohne Konflikt:
   - Infohinweis: „Keine Überschneidung. Änderungen können in den Hauptplaner übernommen werden.“
   - Button enabled.

## 3.4 Interaktionsfluss Löschen
1. User klickt „Löschen“ an Position.
2. Confirm-Dialog: „Auftrag wirklich löschen? Dieser Schritt kann per Undo rückgängig gemacht werden.“
3. Bei Bestätigung:
   - Auftrag aus IST-Linie entfernen.
   - Nachfolgende Positionen rücken auf.
   - Timeline und Konflikte neu berechnen.
4. Erfolgsmeldung + aktualisierte Positionsanzeige.

## 3.5 Undo-Fluss
- Jede mutierende Aktion erzeugt Snapshot in Session-History.
- Klick auf Undo stellt letzten Snapshot wieder her.
- Nach Undo erneut Konfliktprüfung und Button-Status aktualisieren.

## 3.6 Fehlermeldungen / Warnungen

| Code | Typ | Textvorschlag | Trigger |
|---|---|---|---|
| IST-VAL-001 | Fehler | „Restmenge muss eine Zahl >= 0 sein.“ | Ungültiger Input |
| IST-VAL-002 | Fehler | „Restmenge darf Startmenge nicht überschreiten.“ | `rest > start` (falls fachlich begrenzt) |
| IST-CONF-001 | Warnung | „Rührwerksüberschneidung erkannt. ‚Planer aktualisieren‘ ist gesperrt.“ | Konfliktcheck positiv |
| IST-API-001 | Fehler | „Änderung konnte nicht gespeichert werden. Bitte erneut versuchen.“ | 5xx/Netzwerk |
| IST-DEL-001 | Info | „Auftrag wurde gelöscht. Positionen wurden nachgerückt.“ | Delete erfolgreich |
| IST-UPD-001 | Info | „IST-Änderungen wurden in den Hauptplaner übernommen.“ | Update Planner erfolgreich |

---

## 4. Entscheidungslogik (Decision Table)

| Fall | Eingang | Bedingung | Aktion | Ergebnis |
|---|---|---|---|---|
| A | Restmenge speichern | `rest < 0` oder NaN | Reject | Validierungsfehler IST-VAL-001 |
| B | Restmenge speichern | `rest = 0` | Delete-Pfad ausführen | Auftrag entfernt, Positionen rücken nach |
| C | Restmenge speichern | `0 < rest < start` | Dauer proportional verkleinern, Auftrag auf 06:00 setzen, Folgeaufträge nachziehen | Neue Line-Timeline |
| D | Restmenge speichern | `rest = start` | Dauer unverändert, Auftrag auf 06:00, Folgeaufträge nachziehen | Neue Line-Timeline |
| E | Restmenge speichern | Auftrag `locked = true` | `locked` unverändert lassen | Status bleibt locked |
| F | Nach Mutation | Konflikt vorhanden | `canUpdatePlanner = false` | Warnung anzeigen |
| G | Nach Mutation | Kein Konflikt | `canUpdatePlanner = true` | Update-Button aktiv |
| H | Planer aktualisieren | `canUpdatePlanner = false` | Reject | keine Übernahme |
| I | Planer aktualisieren | `canUpdatePlanner = true` | Persist IST-Snapshot als Hauptplan | Erfolgsinfo IST-UPD-001 |
| J | Delete | User bricht Confirm ab | no-op | Keine Änderung |
| K | Undo | History leer | no-op | Undo disabled |
| L | Undo | History nicht leer | letzten Snapshot wiederherstellen + Konfliktcheck | Zustand zurückgesetzt |

---

## 5. Backend-Logik / Rechenregeln

## 5.1 Zeitberechnung je betroffener Linie
Gegeben sortierte Aufträge `o1..on` in bestehender Reihenfolge.

Bei Änderung von Auftrag `oi`:
1. `oi.startAt = 06:00`.
2. Neue Dauer:
   - wenn `rest = 0`: delete.
   - sonst `durationNew = max(1, ceil(durationOriginal * rest/start))`.
3. `oi.endAt = oi.startAt + durationNew`.
4. Für alle Folgeaufträge `oj` mit `j > i`:
   - `oj.startAt = o(j-1).endAt`
   - `oj.endAt = oj.startAt + oj.durationCurrent`
5. Keine Änderung der Reihenfolge.

## 5.2 Konfliktprüfung (Rührwerk)
- Input: geplanter IST-Linienzeitstrahl + bestehende Rührwerksblöcke.
- Pro Rührwerk Blöcke nach Zeit sortieren; Konflikt bei Intervallüberschneidung `a.start < b.end && b.start < a.end`.
- Output:
  - `hasConflicts: boolean`
  - `conflicts: [{mixerId, blockAId, blockBId, overlapStart, overlapEnd}]`

## 5.3 Session-/Persistenzmodell
- `mainPlannerState` = veröffentlichter Hauptplan.
- `istWorkingCopy` = editierbare Session-Kopie.
- Nur Endpoint „Planer aktualisieren“ schreibt `istWorkingCopy -> mainPlannerState`.

---

## 6. API-Vorschlag

## 6.1 REST-Endpunkte

### 6.1.1 IST-Sitzung laden
`GET /api/ist/session?date=YYYY-MM-DD`

Response:
```json
{
  "sessionId": "ist-2026-04-12-user42",
  "lines": [
    {
      "lineId": "L1",
      "positions": [
        {
          "position": 1,
          "orderId": "O-1001",
          "status": "locked",
          "locked": true,
          "startQty": 12000,
          "restQty": 8000,
          "startAt": "06:00",
          "endAt": "08:10",
          "durationMin": 130,
          "mixerId": "M2"
        }
      ]
    }
  ],
  "hasConflicts": false,
  "conflicts": [],
  "canUpdatePlanner": true,
  "dirty": false,
  "historyDepth": 0
}
```

### 6.1.2 Restmenge ändern
`POST /api/ist/session/{sessionId}/orders/{orderId}/rest-qty`

Request:
```json
{
  "restQty": 6500,
  "expectedVersion": 7
}
```

Response:
```json
{
  "version": 8,
  "lineId": "L1",
  "recalculatedPositions": [
    { "position": 1, "orderId": "O-1001", "startAt": "06:00", "endAt": "07:45", "durationMin": 105, "locked": true },
    { "position": 2, "orderId": "O-1002", "startAt": "07:45", "endAt": "09:00", "durationMin": 75 }
  ],
  "hasConflicts": true,
  "conflicts": [
    { "mixerId": "M2", "blockAId": "order-O-1001", "blockBId": "res-901", "overlapStart": "07:20", "overlapEnd": "07:45" }
  ],
  "canUpdatePlanner": false,
  "dirty": true,
  "historyDepth": 1
}
```

### 6.1.3 Auftrag löschen
`DELETE /api/ist/session/{sessionId}/orders/{orderId}`

Request (optional body/query):
```json
{
  "expectedVersion": 8
}
```

Response:
```json
{
  "version": 9,
  "lineId": "L1",
  "recalculatedPositions": [
    { "position": 1, "orderId": "O-1002", "startAt": "06:00", "endAt": "07:15", "durationMin": 75 }
  ],
  "hasConflicts": false,
  "conflicts": [],
  "canUpdatePlanner": true,
  "dirty": true,
  "historyDepth": 2
}
```

### 6.1.4 Undo
`POST /api/ist/session/{sessionId}/undo`

Response analog mit neuem `version`, aktuellem Snapshot, Konfliktstatus.

### 6.1.5 Hauptplaner aktualisieren
`POST /api/ist/session/{sessionId}/publish`

Request:
```json
{
  "expectedVersion": 9
}
```

Response:
```json
{
  "published": true,
  "publishedAt": "2026-04-12T05:20:11Z",
  "mainPlannerVersion": 312,
  "dirty": false
}
```

## 6.2 Fehlercodes API
- `400` Validierung (`IST-VAL-*`)
- `409` Version-Konflikt / Optimistic Locking
- `422` Publish blockiert wegen Konflikten (`IST-CONF-001`)
- `500` Technischer Fehler (`IST-API-001`)

---

## 7. Datenmodelländerungen

## 7.1 Neue/erweiterte Domänenobjekte

### `ist_sessions`
- `id` (PK)
- `date`
- `user_id`
- `working_copy_json` (kompletter IST-Plan)
- `version` (optimistic locking)
- `dirty` (bool)
- `has_conflicts` (bool)
- `created_at`, `updated_at`

### `ist_session_history`
- `id` (PK)
- `session_id` (FK)
- `version`
- `snapshot_json`
- `created_at`

### `orders` (Erweiterung)
- `start_qty` (numeric)
- `rest_qty` (numeric)
- `locked` (bool, vorhanden/übernehmen)
- `position_index` (int, pro Linie)

### Read-Model für UI (`ist_line_positions_v` optional)
- Projektion mit Pos.1–Pos.3 je Linie + status flags + conflict marker.

## 7.2 Invarianten
- `rest_qty >= 0`
- `rest_qty <= start_qty` (wenn fachlich gesetzt)
- Bei Restmengenänderung darf `locked` nicht verändert werden.
- Reihenfolge (`position_index`) ändert sich nur bei explizitem Delete und Nachrücken.

---

## 8. Akzeptanzkriterien (Given/When/Then)

1. **Restmenge editierbar trotz locked**  
   Given ein locked Auftrag, When User Restmenge speichert, Then Änderung wird verarbeitet und `locked=true` bleibt bestehen.

2. **Proportionale Dauer**  
   Given Startmenge 1000 und Dauer 200 min, When Restmenge 500, Then neue Dauer 100 min.

3. **06:00-Anker**  
   Given Änderung an Pos.2, When speichern, Then geänderter Auftrag startet um 06:00.

4. **Folgeaufträge nachziehen ohne Reorder**  
   Given Pos.2/Pos.3 existieren, When Pos.2 geändert, Then Pos.3 startet am neuen Ende von Pos.2, Reihenfolge bleibt.

5. **Restmenge 0 = Delete**  
   Given Auftrag Pos.1, When Restmenge auf 0 gespeichert, Then Auftrag gelöscht und Pos.2 wird Pos.1.

6. **Delete mit Confirm**  
   Given User klickt Löschen, When Confirm abgebrochen, Then keine Änderung.

7. **Konflikt sperrt Publish**  
   Given Überschneidung auf Rührwerk, When IST-Änderung gespeichert, Then Warnung sichtbar und „Planer aktualisieren“ deaktiviert.

8. **Konfliktfrei erlaubt Publish**  
   Given keine Überschneidung, When IST-Änderung gespeichert, Then Publish aktiv.

9. **Publish nur per Button**  
   Given Dirty-IST ohne Button-Klick, When Seite neu geladen, Then Hauptplan unverändert.

10. **Undo verfügbar**  
    Given mindestens eine Änderung, When Undo, Then letzter Zustand vollständig wiederhergestellt inkl. Konfliktstatus.

---

## 9. Konkrete Testfälle

## 9.1 Happy Path
1. **HP-01 Restmenge reduzieren (locked Auftrag)**
   - Arrange: Pos.1 locked, startQty=1000, duration=120.
   - Act: restQty=750 speichern.
   - Assert: duration=90, startAt=06:00, locked bleibt true, Folgeaufträge nachgezogen.

2. **HP-02 Restmenge unverändert (=Startmenge)**
   - Assert: gleiche Dauer, aber Re-Anker auf 06:00 + Nachziehen Folgeaufträge.

3. **HP-03 Löschen per Button**
   - Arrange: Pos.1..Pos.3 vorhanden.
   - Act: Delete Pos.2 bestätigen.
   - Assert: Pos.3 wird Pos.2, keine Lücke.

4. **HP-04 Publish konfliktfrei**
   - Arrange: hasConflicts=false, dirty=true.
   - Act: Klick „Planer aktualisieren“.
   - Assert: API `/publish` 200, dirty=false.

5. **HP-05 Undo nach Restmengenänderung**
   - Assert: exakter vorheriger Snapshot inklusive Zeiten und Konfliktflags.

## 9.2 Edge Cases
1. **EC-01 Restmenge = 0 via Input**
   - Muss identisch zu Delete-Flow sein (inkl. Nachrücken).

2. **EC-02 Restmenge negativ / nicht numerisch**
   - 400 + IST-VAL-001, keine Zustandsänderung.

3. **EC-03 Restmenge > Startmenge**
   - Fachentscheid: entweder blockieren (IST-VAL-002) oder explizit erlauben; bei Blockierung keine Mutation.

4. **EC-04 Konflikt entsteht durch Nachziehen**
   - `hasConflicts=true`, CTA disabled.

5. **EC-05 Gleichzeitige Bearbeitung (Versionkonflikt)**
   - `expectedVersion` veraltet -> 409, UI lädt neuesten Snapshot.

6. **EC-06 Undo bei leerer History**
   - Undo disabled, API optional 409/204 ohne Änderung.

7. **EC-07 Delete abbrechen im Dialog**
   - Keine API-Mutation, keine History-Erhöhung.

8. **EC-08 Publish trotz Konflikt erzwungen**
   - Backend gibt 422 zurück, Hauptplan bleibt unverändert.

## 9.3 Automatisierte Tests (technisch)
- **Unit (Backend):**
  - `recalculateTimeline()` (proportional, 06:00-Anker, Nachziehen)
  - `applyDeleteAndShiftPositions()`
  - `detectMixerConflicts()`
- **API-Integration:**
  - `/rest-qty`, `/delete`, `/undo`, `/publish` inkl. Fehlercodes 400/409/422.
- **Frontend-Component-Tests:**
  - Editierbarkeit Restmenge für alle Status.
  - Disabled-Logik für „Planer aktualisieren“.
  - Confirm-Dialog + Undo.
- **E2E (Playwright/Cypress):**
  - Voller Flow von IST-Änderung bis Publish.

---

## 10. Implementierungsreihenfolge (empfohlen)
1. Backend-Domainfunktionen (Recalc, Delete, Conflict).
2. IST-Session-API mit Versionierung + History.
3. Frontend Route `/ist` + Basismaske Pos.1–Pos.3.
4. Mutationen (Restmenge, Delete, Undo) + Konfliktanzeige.
5. Publish-Flow + Disabled/Enabled-Regeln.
6. Automatisierte Tests und Abnahmeszenarien.

