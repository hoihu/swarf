(swarf: Clamp block M8)
(grblHAL mill, mill, mm)
(stock: block 30 x 30 x 15, raw top at Z0.3, X0 Y0 = front left corner)
G21 G90 G94 G54
G17

(op1: Face top, T2 Endmill Ø10 3F carbide)
(Load T2: Endmill Ø10 3F carbide, touch off, then cycle start)
(from wherever it is then, the tool goes straight to Z12.3 up, or DOWN if it stands higher, then to X0 Y0)
M0
G21 G90 G94 G54
G17
G0 Z12.3
G0 X0 Y0
S6000 M3
G4 P2
X-7 Z2.3
Z0
G1 X37 F900
Y6
X-7
Y12
X37
Y18
X-7
Y24
X37
Y30
X-7
G0 Z1
Y0
Z2.3
Z12.3
X0

(op2: Spot, T4 Chamfer mill Ø6 90° carbide)
M5
(Change to T4: Chamfer mill Ø6 90° carbide, touch off, then cycle start)
(from wherever it is then, the tool goes straight to Z12.3 up, or DOWN if it stands higher, then to X0 Y0)
M0
G21 G90 G94 G54
G17
G0 Z12.3
G0 X0 Y0
S6000 M3
G4 P2
X15 Y15 Z2.3
Z1
G1 Z-3 F63
G0 Z2.3
Z12.3
X0 Y0

(op3: Core hole Ø6.8, T6 Drill Ø6.8 HSS)
M5
(Change to T6: Drill Ø6.8 HSS, touch off, then cycle start)
(from wherever it is then, the tool goes straight to Z12.3 up, or DOWN if it stands higher, then to X0 Y0)
M0
G21 G90 G94 G54
G17
G0 Z12.3
G0 X0 Y0
S1872 M3
G4 P2
X15 Y15 Z2.3
Z1
G1 Z-2 F191
G0 Z1
Z-1.7
G1 Z-5
G0 Z1
Z-4.7
G1 Z-8
G0 Z1
Z-7.7
G1 Z-11
G0 Z1
Z-10.7
G1 Z-13
G0 Z2.3
Z12.3
X0 Y0

(op4: Thread M8, T5 Thread mill Ø5, single form 60°)
M5
(Change to T5: Thread mill Ø5, single form 60°, touch off, then cycle start)
(from wherever it is then, the tool goes straight to Z12.3 up, or DOWN if it stands higher, then to X0 Y0)
M0
G21 G90 G94 G54
G17
G0 Z12.3
G0 X0 Y0
S6000 M3
G4 P2
X15 Y15 Z2.3
Z1
G1 Z-10 F82
G3 X16.302 Y15 Z-10 I0.651 J0 F80
G3 X13.698 Y15 Z-9.375 I-1.302 J0
G3 X16.302 Y15 Z-8.75 I1.302 J0
G3 X13.698 Y15 Z-8.125 I-1.302 J0
G3 X16.302 Y15 Z-7.5 I1.302 J0
G3 X13.698 Y15 Z-6.875 I-1.302 J0
G3 X16.302 Y15 Z-6.25 I1.302 J0
G3 X13.698 Y15 Z-5.625 I-1.302 J0
G3 X16.302 Y15 Z-5 I1.302 J0
G3 X13.698 Y15 Z-4.375 I-1.302 J0
G3 X16.302 Y15 Z-3.75 I1.302 J0
G3 X13.698 Y15 Z-3.125 I-1.302 J0
G3 X16.302 Y15 Z-2.5 I1.302 J0
G3 X13.698 Y15 Z-1.875 I-1.302 J0
G3 X16.302 Y15 Z-1.25 I1.302 J0
G3 X13.698 Y15 Z-0.625 I-1.302 J0
G3 X16.302 Y15 Z0 I1.302 J0
G3 X13.698 Y15 Z0.625 I-1.302 J0
G3 X16.302 Y15 Z1.25 I1.302 J0
G3 X15 Y15 Z1.25 I-0.651 J0
G1 Z-10 F82
G3 X16.5 Y15 Z-10 I0.75 J0 F88
G3 X13.5 Y15 Z-9.375 I-1.5 J0
G3 X16.5 Y15 Z-8.75 I1.5 J0
G3 X13.5 Y15 Z-8.125 I-1.5 J0
G3 X16.5 Y15 Z-7.5 I1.5 J0
G3 X13.5 Y15 Z-6.875 I-1.5 J0
G3 X16.5 Y15 Z-6.25 I1.5 J0
G3 X13.5 Y15 Z-5.625 I-1.5 J0
G3 X16.5 Y15 Z-5 I1.5 J0
G3 X13.5 Y15 Z-4.375 I-1.5 J0
G3 X16.5 Y15 Z-3.75 I1.5 J0
G3 X13.5 Y15 Z-3.125 I-1.5 J0
G3 X16.5 Y15 Z-2.5 I1.5 J0
G3 X13.5 Y15 Z-1.875 I-1.5 J0
G3 X16.5 Y15 Z-1.25 I1.5 J0
G3 X13.5 Y15 Z-0.625 I-1.5 J0
G3 X16.5 Y15 Z0 I1.5 J0
G3 X13.5 Y15 Z0.625 I-1.5 J0
G3 X16.5 Y15 Z1.25 I1.5 J0
G3 X15 Y15 Z1.25 I-0.75 J0
G0 Z2.3
Z12.3
X0 Y0

M5
M30
