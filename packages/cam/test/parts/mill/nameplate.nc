(swarf: Nameplate)
(grblHAL mill, mill, mm)
(stock: block 60 x 20 x 5, raw top at Z0.2, X0 Y0 = front left corner)
G21 G90 G94 G54
G17

(op1: Skim top, T2 Endmill Ø10 3F carbide)
(Load T2: Endmill Ø10 3F carbide, touch off, then cycle start)
(from wherever it is then, the tool goes straight to Z12.2 up, or DOWN if it stands higher, then to X0 Y0)
M0
G21 G90 G94 G54
G17
G0 Z12.2
G0 X0 Y0
S6000 M3
G4 P2
X-7 Z2.2
Z0
G1 X67 F900
Y5
X-7
Y10
X67
Y15
X-7
Y20
X67
G0 Z1
X-7 Y0
Z2.2
Z12.2
X0

(op2: Engrave, T4 Chamfer mill Ø6 90° carbide)
M5
(Change to T4: Chamfer mill Ø6 90° carbide, touch off, then cycle start)
(from wherever it is then, the tool goes straight to Z12.2 up, or DOWN if it stands higher, then to X0 Y0)
M0
G21 G90 G94 G54
G17
G0 Z12.2
G0 X0 Y0
S6000 M3
G4 P2
X12 Y12 Z2.2
Z1
G1 Z-0.2 F63
X11 Y13 F180
X9
X8 Y12
Y11
X9 Y10
X11
X12 Y9
Y8
X11 Y7
X9
X8 Y8
G0 Z1
X13.6 Y13
G1 Z-0.2 F63
X14.6 Y7 F180
X15.6 Y11
X16.6 Y7
X17.6 Y13
G0 Z1
X19.2 Y7
G1 Z-0.2 F63
X21.2 Y13 F180
X23.2 Y7
G0 Z1
X19.9 Y9
G1 Z-0.2 F63
X22.5 F180
G0 Z1
X24.8 Y7
G1 Z-0.2 F63
Y13 F180
X27.8
X28.8 Y12
Y11
X27.8 Y10
X24.8
G0 Z1
X26.8
G1 Z-0.2 F63
X28.8 Y7 F180
G0 Z1
X34.4 Y13
G1 Z-0.2 F63
X30.4 F180
Y7
G0 Z1
Y10
G1 Z-0.2 F63
X33.4 F180
G0 Z1
X41 Y7
G1 Z-0.2 F63
X40 Y8 F180
Y12
X41 Y13
X43
X44 Y12
Y8
X43 Y7
X41
G0 Z1
Y8.5
G1 Z-0.2 F63
X43 Y11.5 F180
G0 Z1
X46.6
G1 Z-0.2 F63
X47.6 Y13 F180
Y7
G0 Z1
X46.6
G1 Z-0.2 F63
X48.6 F180
G0 Z1
Z2.2

(op3: Chamfer top edge, T4 Chamfer mill Ø6 90° carbide)
X61 Y-1
Z1
G1 Z-1.5 F63
X-1 F180
Y21
X61
Y-1
G0 Z2.2
Z12.2
X0 Y0

M5
M30
