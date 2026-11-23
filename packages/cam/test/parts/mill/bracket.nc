(swarf: Mounting bracket 50 x 30 x 5.5)
(grblHAL mill, mill, mm)
(stock: block 60 x 40 x 6, raw top at Z0.5, X0 Y0 = front left corner)
G21 G90 G94 G54
G17

(op1: Face top, T2 Endmill Ø10 3F carbide)
(Load T2: Endmill Ø10 3F carbide, touch off, then cycle start)
(from wherever it is then, the tool goes straight to Z12.5 up, or DOWN if it stands higher, then to X0 Y0)
M0
G21 G90 G94 G54
G17
G0 Z12.5
G0 X0 Y0
S6000 M3
G4 P2
X-7 Z2.5
Z0
G1 X67 F900
Y5.714
X-7
Y11.429
X67
Y17.143
X-7
Y22.857
X67
Y28.571
X-7
Y34.286
X67
Y40
X-7
G0 Z1
Y0
Z2.5
Z12.5
X0

(op2: Spot holes, T4 Chamfer mill Ø6 90° carbide)
M5
(Change to T4: Chamfer mill Ø6 90° carbide, touch off, then cycle start)
(from wherever it is then, the tool goes straight to Z12.5 up, or DOWN if it stands higher, then to X0 Y0)
M0
G21 G90 G94 G54
G17
G0 Z12.5
G0 X0 Y0
S6000 M3
G4 P2
X10 Y10 Z2.5
Z1
G1 Z-3 F63
G0 Z2.5
X50
Z1
G1 Z-3
G0 Z2.5
Y30
Z1
G1 Z-3
G0 Z2.5
X10
Z1
G1 Z-3
G0 Z2.5
Z12.5
X0 Y0

(op3: Drill Ø5 through, T3 Drill Ø5 HSS)
M5
(Change to T3: Drill Ø5 HSS, touch off, then cycle start)
(from wherever it is then, the tool goes straight to Z12.5 up, or DOWN if it stands higher, then to X0 Y0)
M0
G21 G90 G94 G54
G17
G0 Z12.5
G0 X0 Y0
S2546 M3
G4 P2
X10 Y10 Z2.5
Z1
G1 Z-2 F191
G0 Z1
Z-1.7
G1 Z-5
G0 Z1
Z-4.7
G1 Z-5.8
G0 Z2.5
X50
Z1
G1 Z-2
G0 Z1
Z-1.7
G1 Z-5
G0 Z1
Z-4.7
G1 Z-5.8
G0 Z2.5
Y30
Z1
G1 Z-2
G0 Z1
Z-1.7
G1 Z-5
G0 Z1
Z-4.7
G1 Z-5.8
G0 Z2.5
X10
Z1
G1 Z-2
G0 Z1
Z-1.7
G1 Z-5
G0 Z1
Z-4.7
G1 Z-5.8
G0 Z2.5
Z12.5
X0 Y0

(op4: Cut out, tabs, T1 Endmill Ø6 3F carbide)
M5
(Change to T1: Endmill Ø6 3F carbide, touch off, then cycle start)
(from wherever it is then, the tool goes straight to Z12.5 up, or DOWN if it stands higher, then to X0 Y0)
M0
G21 G90 G94 G54
G17
G0 Z12.5
G0 X0 Y0
S6000 M3
G4 P2
X1.8 Y1.8 Z2.5
Z1
G1 Z0.2 F189
Y38.2 Z-1.708 F540
X24.552 Z-2.9
X58.2
Y1.8
X1.8
Y38.2
X58.2
Y1.8
X1.8
Y19.5 Z-3.828
Y30.5 Z-4.404
Y38.2 Z-4.808
X20.735 Z-5.8
X29.5
Z-4.8
X40.5
Z-5.8 F189
X58.2 F540
Y20.5
Z-4.8
Y9.5
Z-5.8 F189
Y1.8 F540
X30.5
Z-4.8
X19.5
Z-5.8 F189
X1.8 F540
Y19.5
Z-4.8
Y30.5
Z-5.8 F189
Y38.2 F540
X29.5
Z-4.8
X40.5
Z-5.8 F189
X58.2 F540
Y20.5
Z-4.8
Y9.5
Z-5.8 F189
Y1.8 F540
X30.5
Z-4.8
X19.5
Z-5.8 F189
X1.8 F540
X2 Y2
Y19.5
Z-4.8
Y30.5
Z-5.8 F189
Y38 F540
X29.5
Z-4.8
X40.5
Z-5.8 F189
X58 F540
Y20.5
Z-4.8
Y9.5
Z-5.8 F189
Y2 F540
X30.5
Z-4.8
X19.5
Z-5.8 F189
X2 F540
X1.8 Y1.8
G0 Z2.5
Z12.5
X0 Y0

M5
M30
