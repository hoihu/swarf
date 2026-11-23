(swarf: Pin Ø12 with clip groove)
(grblHAL lathe, lathe, mm)
(stock: bar Ø16, 45 out of the chuck, raw face at Z1)
(X is a diameter; Z0 = finished front face)
G21 G90 G94 G54
G18 G7 G97

(op1: Face to Z0, T1 Turning, CCMT 09 R0.4 carbide)
(Load T1: Turning, CCMT 09 R0.4 carbide, touch off, then cycle start)
(from wherever it is then, the tool goes along Z to Z23, then to X30)
M0
G21 G90 G94 G54
G18 G7 G97
G0 Z23
G0 X30
S2387 M3
G4 P2
X20 Z3
Z0.5
X18
G1 X0 F191
Z1 F67
G0 X18
X20 Z0
X18
G1 X0 F191
Z0.5 F67
G0 X18
X20
Z3

(op2: Turn Ø12 to Z-33, T1 Turning, CCMT 09 R0.4 carbide)
Z2
X15.1
G1 Z-33 F191
X16.1 Z-32.5
G0 Z2
X20
X14.2
G1 Z-33
X15.2 Z-32.5
G0 Z2
X20
X13.3
G1 Z-33
X14.3 Z-32.5
G0 Z2
X20
X12.4
G1 Z-33
X13.4 Z-32.5
G0 Z2
X20
X12
G1 Z-33
X16
X17 Z-32.5
G0 X20
Z3

(op3: Chamfer 1×45° at Ø12, T1 Turning, CCMT 09 R0.4 carbide)
S2500 M3
G4 P1
Z2
X9.531
G1 Z0 F70
X12 Z-1.234 F200
X14 Z-1
G0 X20
Z3
Z23
X30

(op4: Groove Ø10 × 2 at Z-24, T2 Parting blade 2 mm)
M5
(Change to T2: Parting blade 2 mm, touch off, then cycle start)
(from wherever it is then, the tool goes along Z to Z23, then to X30)
M0
G21 G90 G94 G54
G18 G7 G97
G0 Z23
G0 X30
S1592 M3
G4 P2
X20 Z3
Z-24
X13
G1 X10 F48
G0 X13
X20
Z3

(op5: Part off at Z-30, T2 Parting blade 2 mm)
S1194 M3
G4 P1
Z-30
X17
G1 X0 F36
G0 X17
X20
Z3
Z23
X30

M5
M30
