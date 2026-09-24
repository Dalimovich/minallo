Institut für Konstruktionstechnik
Institut für Flugzeugbau und Leichtbau
Seite 8 / 12
09.03.2026

## Zylindrische Schraubenzugfedern / cylindrical helical extension springs

$$ F = F_0 + s \cdot \frac{G \cdot d^4}{8 \cdot n \cdot D^3} $$
Funktionsnachweis / functional verification

$$ R = \frac{G \cdot d^4}{8 \cdot n \cdot D^3} $$
Federrate / spring rate

$$ \tau_{max} = F \cdot k \cdot \frac{8 \cdot D}{\pi \cdot d^3} $$
Festigkeitsnachweis / strength verification
(statische Belastung / static loading, tau_max <= tau_zul)

$$ \tau_{zul} \approx 0{,}45 \cdot R_m $$
Zulässige Spannung (überschlägige Berechnung) / permissible stress (rough preliminary calculation)

## Schraubenberechnung / bolt calculation

$$ F_Z = \frac{f_Z}{\delta_S + \delta_P} $$
Vorspannkraftverlust / loss of preload

$$ \delta_S = \delta_K + \sum_{i=1}^{n} \delta_i + \delta_G + \delta_M $$
Elastische Schraubennachgiebigkeit / elastic resilience of the bolt

$$ \delta_K = \frac{l'_K}{E_S \cdot A_N} $$
Nachgiebigkeit des Schraubenkopfes / resilience of the bolt head

$$ l'_K = 0{,}5 \cdot d $$
Sechskantschrauben / hexagon head bolt

$$ l'_K = 0{,}4 \cdot d $$
Innensechskantschrauben / hexagon socket head cap screw

$$ \delta_i = \frac{l_i}{E_S \cdot A_i} $$
Nachgiebigkeit der zylindrischen Teileelemente / resilience of the cylindrical elements

$$ \delta_G = \frac{0{,}5 \cdot d}{E_S \cdot A_3} $$
Nachgiebigkeit des eingeschraubten Gewindeteils / resilience of the engaged thread

$$ \delta_M = \frac{l_M}{E_M \cdot A_N} $$
Nachgiebigkeit der Mutter oder des Einschraubgewindebereichs / resilience of the nut or tapped thread region

$$ l_M = 0{,}4 \cdot d,\ E_M = E_S $$
Durchsteckschraubverbindung / through-bolt joint

$$ l_M = 0{,}33 \cdot d,\ E_M = E_P $$
Einschraubverbindung / tapped thread joint

$$ \delta_P = \frac{l_K}{E_P \cdot A_{ers}} $$
Elastische Nachgiebigkeit der verspannten Teile / elastic resilience of the clamped parts
