package webmc;

/**
 * NpeProbe - does CheerpJ honour Java exception tables for *implicit*
 * NullPointerExceptions?
 *
 * Why this matters: Mojang's startup path uses NPE as control flow. ModelBlock.
 * checkModelHierarchy (class `bvu`, method b(Map)) walks a model's parent chain
 * and treats running off the end as an exception:
 *
 *     try {
 *         ModelBlock m = model.getParent();
 *         m = m.getParent();
 *         while (m != model) { m = m.getParent(); m = m.getParent().getParent(); }
 *         throw new ModelBlockCycleError();
 *     } catch (NullPointerException e) { }   // <- normal termination, not an error
 *
 * Under CheerpJ 4.3 that NPE escapes the catch and the game dies with
 * "NullPointerException: Initializing game" at bvu.b.
 *
 * Each case runs on its own thread with an uncaught-exception handler, so one
 * uncatchable NPE does not take the probe with it and we get the whole matrix.
 */
public class NpeProbe {

  static class Node {
    Node next;
  }

  interface Test {
    String run();
  }

  static String caseOnOwnThread(String label, Test t) {
    final String[] result = new String[1];
    Thread worker = new Thread(new Runnable() {
      public void run() { result[0] = t.run(); }
    }, "probe-" + label);
    worker.setUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
      public void uncaughtException(Thread th, Throwable e) {
        result[0] = "ESCAPED(" + e.getClass().getName() + ")";
      }
    });
    worker.start();
    try {
      worker.join(10000);
    } catch (InterruptedException ie) {
    }
    try {
      Thread.sleep(150);   // let the handler finish writing
    } catch (InterruptedException ie) {
    }
    String r = result[0] == null ? "NO-RESULT" : result[0];
    System.out.println("[npeprobe] " + label + ": " + r);
    return r;
  }

  /** The exact shape of Mojang's parent-chain walk: deref a null field. */
  static String implicitFieldDeref() {
    return new Test() {
      public String run() {
        Node n = new Node();
        try {
          Node p = n.next;   // null
          p = p.next;        // implicit NPE
          return "no exception at all";
        } catch (NullPointerException e) {
          return "caught";
        }
      }
    }.run();
  }

  /** Implicit NPE from invoking a method on null. */
  static String implicitVirtualCall() {
    return new Test() {
      public String run() {
        String s = null;
        try {
          return "no exception (len=" + s.length() + ")";
        } catch (NullPointerException e) {
          return "caught";
        }
      }
    }.run();
  }

  /** Implicit NPE from arraylength of a null array. */
  static String implicitArrayLength() {
    return new Test() {
      public String run() {
        Object[] a = null;
        try {
          return "no exception (len=" + a.length + ")";
        } catch (NullPointerException e) {
          return "caught";
        }
      }
    }.run();
  }

  /** An explicit throw, for contrast. */
  static String explicitThrow() {
    return new Test() {
      public String run() {
        try {
          throw new NullPointerException("explicit");
        } catch (NullPointerException e) {
          return "caught (" + e.getMessage() + ")";
        }
      }
    }.run();
  }

  /** Same implicit NPE, but caught as Throwable. */
  static String implicitFieldDerefAsThrowable() {
    return new Test() {
      public String run() {
        Node n = new Node();
        try {
          Node p = n.next;
          p = p.next;
          return "no exception at all";
        } catch (Throwable e) {
          return "caught as " + e.getClass().getName();
        }
      }
    }.run();
  }

  /** Mojang's loop verbatim over an acyclic 3-node chain. */
  static String mojangWalk() {
    return new Test() {
      public String run() {
        java.util.Map<Integer, Node> map = new java.util.LinkedHashMap<Integer, Node>();
        Node a = new Node(), b = new Node(), c = new Node();
        a.next = b;
        b.next = c;
        map.put(1, a);
        map.put(2, b);
        map.put(3, c);
        try {
          for (Node m : map.values()) {
            Node p = m.next;
            Node q = p.next;
            while (p != m) {
              p = p.next;
              q = q.next.next;
            }
            return "claimed a cycle that isn't there";
          }
          return "walked cleanly";
        } catch (NullPointerException e) {
          return "NPE escaped the per-model catch (this is the game's crash)";
        }
      }
    }.run();
  }

  public static void main(String[] args) throws Exception {
    System.out.println("[npeprobe] java=" + System.getProperty("java.version")
        + " vm=" + System.getProperty("java.vm.name"));
    String r1 = caseOnOwnThread("getfield", new Test() {
      public String run() { return implicitFieldDeref(); }
    });
    String r2 = caseOnOwnThread("virtualcall", new Test() {
      public String run() { return implicitVirtualCall(); }
    });
    String r3 = caseOnOwnThread("arraylength", new Test() {
      public String run() { return implicitArrayLength(); }
    });
    String r4 = caseOnOwnThread("explicit", new Test() {
      public String run() { return explicitThrow(); }
    });
    String r5 = caseOnOwnThread("as throwable", new Test() {
      public String run() { return implicitFieldDerefAsThrowable(); }
    });
    String r6 = caseOnOwnThread("mojang walk", new Test() {
      public String run() { return mojangWalk(); }
    });
    System.out.println("[npeprobe] matrix getfield=" + r1 + " | virtual=" + r2 + " | array=" + r3
        + " | explicit=" + r4 + " | throwable=" + r5 + " | walk=" + r6);
  }
}
